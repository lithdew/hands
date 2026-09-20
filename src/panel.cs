// The Windows panel: run as "<helper.exe> panel <url> <data dir>", one JSON command per line on stdin, as
// shell-windows.ts sends them. A borderless, never-activating tool window in the corner with a WebView2 in it,
// showing the same page as the Mac's panel. The web view is told to paint nothing behind the page, the window's
// own colour is the key (LWA_COLORKEY through the form's TransparencyKey), and so every pixel the page leaves
// clear is not there: not on the screen, and not to the mouse. The cards float, as on the Mac. (A browser window
// cannot be made to do this: Chromium presents through DirectComposition, past the surface the key is applied to,
// and paints a title strip of its own in --app mode that no flag removes; measured, see the README.)
//
// WebView2 is hosted without its SDK: the runtime that comes with Edge exports the loader's entry point from
// EmbeddedBrowserWebView.dll, and the few COM interfaces used are declared here, with their published GUIDs.
// All coordinates are physical pixels: the process is per-monitor DPI aware, and the page renders at the display's scale.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Panel
{
    public static int Run(string[] args)
    {
        if (args.Length < 3) { Console.Error.WriteLine("usage: hands-win panel <url> <data dir>"); return 2; }
        string dll = Runtime();
        if (dll == null) { Console.Error.WriteLine("panel: the WebView2 runtime that comes with Microsoft Edge is not installed"); return 3; }
        int code = 0;
        var ui = new Thread(delegate () { code = Serve(args[1], args[2], dll); }); // WebView2 wants a single-threaded apartment with a message loop
        ui.SetApartmentState(ApartmentState.STA);
        ui.Start();
        ui.Join();
        return code;
    }

    static int Serve(string url, string dataDir, string dll)
    {
        HandNative.SetProcessDpiAwarenessContext(new IntPtr(-4));
        var window = new PanelWindow(url, dataDir, dll);
        IntPtr handle = window.Handle; // created hidden: the first `fit` shows it
        window.Open();
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var reader = new Thread(delegate ()
        {
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                string command = line;
                if (command.Trim().Length > 0) window.BeginInvoke((Action)delegate { window.Obey(command); });
            }
            window.BeginInvoke((Action)window.Quit); // the orchestrator is gone
        });
        reader.IsBackground = true;
        reader.Start();
        Application.Run();
        return window.Failed ? 3 : 0;
    }

    /** The newest WebView2 runtime on this PC: the Evergreen one that ships with Edge, a per-user one, or Edge itself, which carries the same DLL. */
    static string Runtime()
    {
        var roots = new List<string>();
        foreach (string env in new[] { "ProgramFiles(x86)", "LOCALAPPDATA", "ProgramFiles" })
        {
            string root = Environment.GetEnvironmentVariable(env);
            if (string.IsNullOrEmpty(root)) continue;
            roots.Add(Path.Combine(root, "Microsoft", "EdgeWebView", "Application"));
            roots.Add(Path.Combine(root, "Microsoft", "Edge", "Application"));
        }
        foreach (string root in roots)
        {
            if (!Directory.Exists(root)) continue;
            Version best = null; string found = null;
            foreach (string dir in Directory.GetDirectories(root))
            {
                Version version;
                string dll = Path.Combine(dir, "EBWebView", "x64", "EmbeddedBrowserWebView.dll");
                if (!Version.TryParse(Path.GetFileName(dir), out version) || !File.Exists(dll)) continue;
                if (best == null || version > best) { best = version; found = dll; }
            }
            if (found != null) return found;
        }
        return null;
    }
}

class PanelWindow : Form
{
    static readonly Color KEY = Color.FromArgb(1, 2, 3); // the page never paints this: it is what "nothing" looks like to the window
    readonly string url, dataDir, dll;
    ICoreWebView2Controller controller;
    ICoreWebView2 web;
    WebView2EnvironmentCompleted onEnvironment; WebView2ControllerCompleted onController; // kept: the runtime holds them only as COM pointers
    WebView2CreateEnvironment create;
    bool keyboard = false; // whether the page may have the keyboard: a sheet with its box is open
    IntPtr previous = IntPtr.Zero; // who had the foreground before the page took it
    public bool Failed = false;

    public PanelWindow(string url, string dataDir, string dll)
    {
        this.url = url; this.dataDir = dataDir; this.dll = dll;
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual; Text = "hands";
        AutoScaleMode = AutoScaleMode.None;
        BackColor = KEY; TransparencyKey = KEY;
        SetBounds(-10, -10, 10, 10);
    }
    protected override CreateParams CreateParams
    {
        get { CreateParams p = base.CreateParams; p.ExStyle |= HandNative.WS_EX_TOOLWINDOW | HandNative.WS_EX_NOACTIVATE | HandNative.WS_EX_TOPMOST; return p; }
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        HandNative.SetWindowDisplayAffinity(Handle, HandNative.WDA_EXCLUDEFROMCAPTURE); // out of every capture, like the hands themselves
    }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == HandNative.WM_MOUSEACTIVATE && !keyboard) { m.Result = (IntPtr)HandNative.MA_NOACTIVATE; return; } // a click on a card never takes the user out of their app
        base.WndProc(ref m);
    }

    // ------------------------------------------------------------------ the web view

    public void Open()
    {
        IntPtr module = PanelNative.LoadLibraryExW(dll, IntPtr.Zero, PanelNative.LOAD_WITH_ALTERED_SEARCH_PATH);
        IntPtr entry = module == IntPtr.Zero ? IntPtr.Zero : PanelNative.GetProcAddress(module, "CreateWebViewEnvironmentWithOptionsInternal");
        if (entry == IntPtr.Zero) { Fail("the WebView2 runtime at " + dll + " has no loader entry point (error " + Marshal.GetLastWin32Error() + ")"); return; }
        create = (WebView2CreateEnvironment)Marshal.GetDelegateForFunctionPointer(entry, typeof(WebView2CreateEnvironment));
        onEnvironment = new WebView2EnvironmentCompleted(delegate (int hr, ICoreWebView2Environment environment)
        {
            if (hr < 0 || environment == null) { Fail("WebView2 gave no environment (0x" + hr.ToString("X8") + ")"); return; }
            onController = new WebView2ControllerCompleted(delegate (int hr2, ICoreWebView2Controller made)
            {
                if (hr2 < 0 || made == null) { Fail("WebView2 gave no controller (0x" + hr2.ToString("X8") + ")"); return; }
                controller = made;
                try { ((ICoreWebView2Controller2)made).put_DefaultBackgroundColor(new WebView2Color { A = 0 }); } // nothing behind the page: the key colour shows, and is not there
                catch (InvalidCastException) { Console.Error.WriteLine("panel: this WebView2 runtime cannot paint a clear background; the panel will be a dark rectangle"); }
                Fit();
                controller.put_IsVisible(1);
                if (controller.get_CoreWebView2(out web) < 0 || web == null) { Fail("WebView2 gave no web view"); return; }
                web.Navigate(url);
            });
            if (environment.CreateCoreWebView2Controller(Handle, onController) < 0) Fail("WebView2 would not make a controller");
        });
        Directory.CreateDirectory(dataDir);
        int made2 = create(true, 0, dataDir, IntPtr.Zero, onEnvironment); // as WebView2Loader.dll calls it: (the browser's own runtime kind, options, the data folder, no environment options)
        if (made2 < 0) Fail("WebView2 would not start (0x" + made2.ToString("X8") + ")");
    }
    void Fail(string why)
    {
        Console.Error.WriteLine("panel: " + why);
        Failed = true;
        Quit();
    }
    /** The web view fills the window, whatever the window is now. */
    void Fit()
    {
        if (controller == null) return;
        controller.put_Bounds(new HandNative.RECT { left = 0, top = 0, right = ClientSize.Width, bottom = ClientSize.Height });
        controller.NotifyParentWindowPositionChanged();
    }

    // ------------------------------------------------------------------ commands

    public void Obey(string line)
    {
        Dictionary<string, object> command;
        try { command = HandJson.Parse(line) as Dictionary<string, object>; } catch (Exception error) { Console.Error.WriteLine("panel: " + error.Message); return; }
        if (command == null) return;
        object value;
        string cmd = command.TryGetValue("cmd", out value) ? value as string : null;
        if (cmd == "fit")
        {
            HandNative.SetWindowPos(Handle, HandNative.HWND_TOPMOST, Int(command, "x"), Int(command, "y"), Int(command, "w"), Int(command, "h"), HandNative.SWP_NOACTIVATE | PanelNative.SWP_SHOWWINDOW);
            Fit();
        }
        else if (cmd == "hide") HandNative.SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, HandNative.SWP_NOMOVE | HandNative.SWP_NOSIZE | HandNative.SWP_NOZORDER | HandNative.SWP_NOACTIVATE | PanelNative.SWP_HIDEWINDOW);
        else if (cmd == "focus") Keyboard(command.TryGetValue("on", out value) && value is bool && (bool)value);
    }
    static int Int(Dictionary<string, object> command, string key)
    {
        object value;
        return command.TryGetValue(key, out value) ? (int)Math.Round(Convert.ToDouble(value)) : 0;
    }

    /**
     * Give the page the keyboard, or hand it back to whatever the user was in. A window that never activates cannot
     * type, so for as long as a sheet is open the window may activate, and it is brought to the front the way the
     * shell hands the foreground back: with its input attached to the foreground's, which is what makes it allowed.
     */
    void Keyboard(bool on)
    {
        int style = HandNative.GetWindowLong(Handle, HandNative.GWL_EXSTYLE);
        if (on)
        {
            IntPtr front = PanelNative.GetForegroundWindow();
            if (!keyboard && front != Handle) previous = front;
            keyboard = true;
            HandNative.SetWindowLong(Handle, HandNative.GWL_EXSTYLE, style & ~HandNative.WS_EX_NOACTIVATE);
            Front(Handle);
            if (controller != null) controller.MoveFocus(0); // programmatic: into the page, where the box has asked for it
            return;
        }
        if (!keyboard) return;
        keyboard = false;
        HandNative.SetWindowLong(Handle, HandNative.GWL_EXSTYLE, style | HandNative.WS_EX_NOACTIVATE);
        if (PanelNative.GetForegroundWindow() != Handle) return; // the user has already gone elsewhere
        if (previous != IntPtr.Zero && HandNative.IsWindow(previous) && HandNative.IsWindowVisible(previous) && Front(previous)) return;
        HandNative.ShowWindow(Handle, HandNative.SW_HIDE); // no one to give it to: shown again without activation, the system picks the next window
        HandNative.SetWindowPos(Handle, HandNative.HWND_TOPMOST, 0, 0, 0, 0, HandNative.SWP_NOMOVE | HandNative.SWP_NOSIZE | HandNative.SWP_NOACTIVATE | PanelNative.SWP_SHOWWINDOW);
    }
    static bool Front(IntPtr window)
    {
        IntPtr front = PanelNative.GetForegroundWindow();
        if (front == window) return true;
        uint pid, ours = PanelNative.GetCurrentThreadId(), theirs = front == IntPtr.Zero ? 0 : PanelNative.GetWindowThreadProcessId(front, out pid);
        if (theirs != 0 && theirs != ours) PanelNative.AttachThreadInput(ours, theirs, true);
        bool given = PanelNative.SetForegroundWindow(window);
        if (theirs != 0 && theirs != ours) PanelNative.AttachThreadInput(ours, theirs, false);
        return given;
    }

    public void Quit()
    {
        try { if (controller != null) controller.Close(); } catch (Exception) { }
        controller = null;
        Application.Exit();
    }
}

static class PanelNative
{
    public const uint SWP_SHOWWINDOW = 0x40, SWP_HIDEWINDOW = 0x80, LOAD_WITH_ALTERED_SEARCH_PATH = 8;
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr LoadLibraryExW(string path, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)] public static extern IntPtr GetProcAddress(IntPtr module, string name);
}

// ------------------------------------------------------------------ WebView2, by hand
// The runtime's loader entry point, as WebView2Loader.dll calls it, and the interfaces used, in vtable order, with
// the GUIDs the SDK publishes. A COM interface declared this way does not inherit its base's slots, so Controller2
// says all of Controller's again. Unused methods are named by their slot.

[StructLayout(LayoutKind.Sequential)] struct WebView2Color { public byte A, R, G, B; }
[StructLayout(LayoutKind.Sequential)] struct WebView2Token { public long value; }

[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate int WebView2CreateEnvironment([MarshalAs(UnmanagedType.I1)] bool evergreen, int kind, [MarshalAs(UnmanagedType.LPWStr)] string dataDir, IntPtr options, IWebView2EnvironmentCompleted handler);

[ComImport, Guid("4E8A3389-C9D8-4BD2-B6B5-124FEE6CC14D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWebView2EnvironmentCompleted { [PreserveSig] int Invoke(int hr, ICoreWebView2Environment environment); }

[ComImport, Guid("6C4819F3-C9B7-4260-8127-C9F5BDE7F68C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWebView2ControllerCompleted { [PreserveSig] int Invoke(int hr, ICoreWebView2Controller controller); }

[ComImport, Guid("B96D755E-0319-4E92-A296-23436F46A1FC"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICoreWebView2Environment
{
    [PreserveSig] int CreateCoreWebView2Controller(IntPtr parent, IWebView2ControllerCompleted handler);
    [PreserveSig] int CreateWebResourceResponse(IntPtr content, int status, IntPtr reason, IntPtr headers, out IntPtr response);
    [PreserveSig] int get_BrowserVersionString(out IntPtr version);
    [PreserveSig] int add_NewBrowserVersionAvailable(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_NewBrowserVersionAvailable(WebView2Token token);
}

[ComImport, Guid("4D00C0D1-9434-4EB6-8078-8697A560334F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICoreWebView2Controller
{
    [PreserveSig] int get_IsVisible(out int visible);
    [PreserveSig] int put_IsVisible(int visible);
    [PreserveSig] int get_Bounds(out HandNative.RECT bounds);
    [PreserveSig] int put_Bounds(HandNative.RECT bounds);
    [PreserveSig] int get_ZoomFactor(out double zoom);
    [PreserveSig] int put_ZoomFactor(double zoom);
    [PreserveSig] int add_ZoomFactorChanged(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_ZoomFactorChanged(WebView2Token token);
    [PreserveSig] int SetBoundsAndZoomFactor(HandNative.RECT bounds, double zoom);
    [PreserveSig] int MoveFocus(int reason);
    [PreserveSig] int add_MoveFocusRequested(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_MoveFocusRequested(WebView2Token token);
    [PreserveSig] int add_GotFocus(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_GotFocus(WebView2Token token);
    [PreserveSig] int add_LostFocus(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_LostFocus(WebView2Token token);
    [PreserveSig] int add_AcceleratorKeyPressed(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_AcceleratorKeyPressed(WebView2Token token);
    [PreserveSig] int get_ParentWindow(out IntPtr parent);
    [PreserveSig] int put_ParentWindow(IntPtr parent);
    [PreserveSig] int NotifyParentWindowPositionChanged();
    [PreserveSig] int Close();
    [PreserveSig] int get_CoreWebView2(out ICoreWebView2 web);
}

[ComImport, Guid("C979903E-D4CA-4228-92EB-47EE3FA96EAB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICoreWebView2Controller2
{
    [PreserveSig] int get_IsVisible(out int visible);
    [PreserveSig] int put_IsVisible(int visible);
    [PreserveSig] int get_Bounds(out HandNative.RECT bounds);
    [PreserveSig] int put_Bounds(HandNative.RECT bounds);
    [PreserveSig] int get_ZoomFactor(out double zoom);
    [PreserveSig] int put_ZoomFactor(double zoom);
    [PreserveSig] int add_ZoomFactorChanged(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_ZoomFactorChanged(WebView2Token token);
    [PreserveSig] int SetBoundsAndZoomFactor(HandNative.RECT bounds, double zoom);
    [PreserveSig] int MoveFocus(int reason);
    [PreserveSig] int add_MoveFocusRequested(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_MoveFocusRequested(WebView2Token token);
    [PreserveSig] int add_GotFocus(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_GotFocus(WebView2Token token);
    [PreserveSig] int add_LostFocus(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_LostFocus(WebView2Token token);
    [PreserveSig] int add_AcceleratorKeyPressed(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_AcceleratorKeyPressed(WebView2Token token);
    [PreserveSig] int get_ParentWindow(out IntPtr parent);
    [PreserveSig] int put_ParentWindow(IntPtr parent);
    [PreserveSig] int NotifyParentWindowPositionChanged();
    [PreserveSig] int Close();
    [PreserveSig] int get_CoreWebView2(out ICoreWebView2 web);
    [PreserveSig] int get_DefaultBackgroundColor(out WebView2Color colour);
    [PreserveSig] int put_DefaultBackgroundColor(WebView2Color colour);
}

[ComImport, Guid("76ECEACB-0462-4D94-AC83-423A6793775E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICoreWebView2
{
    [PreserveSig] int get_Settings(out IntPtr settings);
    [PreserveSig] int get_Source(out IntPtr source);
    [PreserveSig] int Navigate([MarshalAs(UnmanagedType.LPWStr)] string uri);
    [PreserveSig] int NavigateToString([MarshalAs(UnmanagedType.LPWStr)] string html);
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
class WebView2EnvironmentCompleted : IWebView2EnvironmentCompleted
{
    readonly Action<int, ICoreWebView2Environment> then;
    public WebView2EnvironmentCompleted(Action<int, ICoreWebView2Environment> then) { this.then = then; }
    public int Invoke(int hr, ICoreWebView2Environment environment) { then(hr, environment); return 0; }
}
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
class WebView2ControllerCompleted : IWebView2ControllerCompleted
{
    readonly Action<int, ICoreWebView2Controller> then;
    public WebView2ControllerCompleted(Action<int, ICoreWebView2Controller> then) { this.then = then; }
    public int Invoke(int hr, ICoreWebView2Controller controller) { then(hr, controller); return 0; }
}
