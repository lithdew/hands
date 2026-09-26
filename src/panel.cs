// The Windows panel: run as "<helper.exe> panel <url> <data dir>", one JSON command per line on stdin, as
// shell-windows.ts sends them. A borderless, never-activating tool window in the corner with a WebView2 in it,
// showing the same page as the Mac's panel. The web view is told to paint nothing behind the page, the window's
// own colour is the key (LWA_COLORKEY through the form's TransparencyKey), and so every pixel the page leaves
// clear is not on the screen. The cards float, as on the Mac. (A browser window cannot be made to do this:
// Chromium presents through DirectComposition, past the surface the key is applied to, and paints a title strip
// of its own in --app mode that no flag removes; measured, see the README.) The mouse is another matter: the web
// view is a child window of the browser's, and it takes the mouse over every pixel of it, clear or not (measured:
// WindowFromPoint over a clear pixel is the panel), so the page says where it is solid, and the window lets the
// mouse through everywhere else (Pass).
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
        // It could not even start (no loader entry point, or the runtime said no at once): the process ends, and says
        // so, and the orchestrator tries another later. Application.Exit before the loop has begun does not stop the
        // loop Application.Run would begin, which would run for nothing, and nobody would know.
        if (window.Failed) return 3;
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
    WebView2EnvironmentCompleted onEnvironment; WebView2ControllerCompleted onController; WebView2ProcessFailed onFailed; WebView2MessageReceived onMessage; // kept: the runtime holds them only as COM pointers
    WebView2CreateEnvironment create;
    bool keyboard = false; // whether the page may have the keyboard: a sheet with its box is open
    IntPtr previous = IntPtr.Zero; // who had the foreground before the page took it
    bool quitting = false;
    int restarts = 0; // how many times the web view has been made again after its browser process went away
    Rectangle[] solid = new Rectangle[0]; // where the page shows something, in the window's pixels, as it last said
    bool through = true; // whether the mouse goes through the window now, all of it
    readonly System.Windows.Forms.Timer pointer = new System.Windows.Forms.Timer { Interval = 30 }; // how often the pointer is looked for over the page
    readonly string[] seat = SeatLocks();
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
        get { CreateParams p = base.CreateParams; p.ExStyle |= HandNative.WS_EX_TOOLWINDOW | HandNative.WS_EX_NOACTIVATE | HandNative.WS_EX_TOPMOST | HandNative.WS_EX_TRANSPARENT; return p; }
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Out of every capture, like the hands themselves; HANDS_RECORDABLE=1 leaves it in, for a demo or a bug report.
        if (Environment.GetEnvironmentVariable("HANDS_RECORDABLE") != "1") HandNative.SetWindowDisplayAffinity(Handle, HandNative.WDA_EXCLUDEFROMCAPTURE);
        pointer.Tick += delegate { Pass(); };
        pointer.Start();
    }
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Alt+F4 while a sheet has the keyboard, or anything else's WM_CLOSE, would take the window away and leave the
        // process running without it: the panel goes when the orchestrator does, or when Windows does.
        if (!quitting && e.CloseReason != CloseReason.WindowsShutDown) { e.Cancel = true; return; }
        base.OnFormClosing(e);
    }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == HandNative.WM_MOUSEACTIVATE && !keyboard) { m.Result = (IntPtr)HandNative.MA_NOACTIVATE; return; } // a click on a card never takes the user out of their app
        base.WndProc(ref m);
        // The window itself was given the focus while a sheet is open: the foreground came back to it from a hand's
        // window (a borrow of the seat, a guarded click into a browser window, a window handed back). Activating a
        // window focuses the window, not the page in it, and the box would stop hearing the keys with its caret still
        // showing: the focus goes on into the page, which gives it back to the box that had it.
        if (m.Msg == PanelNative.WM_SETFOCUS && keyboard && controller != null)
            BeginInvoke((Action)delegate { if (keyboard && controller != null) controller.MoveFocus(0); });
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
                Fit(); // and shows it
                if (controller.get_CoreWebView2(out web) < 0 || web == null) { Fail("WebView2 gave no web view"); return; }
                Configure();
                onFailed = new WebView2ProcessFailed(delegate (int kind) { BeginInvoke((Action<int>)Recover, kind); }); // after the event: a web view is not remade from inside its own
                WebView2Token token;
                if (web.add_ProcessFailed(onFailed, out token) < 0) Console.Error.WriteLine("panel: cannot watch the web view's processes; a crash will leave it blank");
                onMessage = new WebView2MessageReceived(Heard);
                if (web.add_WebMessageReceived(onMessage, out token) < 0) Console.Error.WriteLine("panel: cannot hear the page; the mouse will go through all of it");
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

    /**
     * A panel, not a browser: no menu of the browser's own, no zoom (it would change the page's size under a window
     * fitted to it), and no pinch zoom either (a pinch scales what is drawn and not the page, and the solid places the
     * page gives would no longer be where it is drawn), no status bar, no error page (a page that failed to load is
     * nothing, not an opaque box in the corner of the screen), no browser keys (F5, Ctrl+P, F12: the editing keys
     * stay), and dev tools only under HANDS_DEBUG.
     */
    void Configure()
    {
        ICoreWebView2Settings settings;
        if (web.get_Settings(out settings) < 0 || settings == null) { Console.Error.WriteLine("panel: WebView2 gave no settings; the panel is a browser page"); return; }
        bool debug = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("HANDS_DEBUG"));
        settings.put_AreDefaultContextMenusEnabled(0);
        settings.put_IsZoomControlEnabled(0);
        settings.put_IsStatusBarEnabled(0);
        settings.put_IsBuiltInErrorPageEnabled(0);
        settings.put_AreDevToolsEnabled(debug ? 1 : 0);
        int keys = 1, pinch = 1;
        try
        {
            ICoreWebView2Settings3 more = (ICoreWebView2Settings3)settings;
            more.put_AreBrowserAcceleratorKeysEnabled(0);
            more.get_AreBrowserAcceleratorKeysEnabled(out keys);
        }
        catch (InvalidCastException) { } // a runtime older than the setting: its keys stay
        try
        {
            ICoreWebView2Settings5 touch = (ICoreWebView2Settings5)settings;
            touch.put_IsPinchZoomEnabled(0);
            touch.get_IsPinchZoomEnabled(out pinch);
        }
        catch (InvalidCastException) { } // a runtime older than the setting: a pinch still zooms
        if (!debug) return;
        int menus, zoom, bar, tools, script;
        settings.get_AreDefaultContextMenusEnabled(out menus); settings.get_IsZoomControlEnabled(out zoom); settings.get_IsStatusBarEnabled(out bar); settings.get_AreDevToolsEnabled(out tools); settings.get_IsScriptEnabled(out script);
        Console.Error.WriteLine("panel: script " + script + ", context menus " + menus + ", zoom " + zoom + ", pinch zoom " + pinch + ", status bar " + bar + ", dev tools " + tools + ", browser keys " + keys);
    }

    /**
     * One of the web view's processes went away. A page whose renderer crashed or hung is loaded again (it reconnects
     * and is sent everything afresh); a browser process that went away took the web view with it, which is made
     * again, three times at most. Anything else (the GPU process, a utility) the runtime starts again by itself, and
     * the page stays as it was. A page loaded again has no sheet out and says nothing solid yet: the keyboard is
     * handed back (the page will never say it can go, and a click on a card would take the user out of their app),
     * and the mouse goes through until the page says where it is.
     */
    void Recover(int kind)
    {
        Console.Error.WriteLine("panel: a WebView2 process went away (kind " + kind + ")");
        bool reload = kind == WebView2ProcessFailed.RENDERER_EXITED || kind == WebView2ProcessFailed.RENDERER_HUNG || kind == WebView2ProcessFailed.UNKNOWN;
        if (!reload && kind != WebView2ProcessFailed.BROWSER_EXITED) return;
        Keyboard(false);
        solid = new Rectangle[0];
        Pass();
        if (reload)
        {
            if (web != null) web.Navigate(url);
            return;
        }
        if (++restarts > 3) { Fail("the WebView2 browser process keeps going away"); return; }
        try { if (controller != null) controller.Close(); } catch (Exception) { }
        controller = null;
        web = null;
        Open();
    }
    /**
     * The web view fills the window, whatever the window is now. It is hidden while its bounds change and shown again:
     * a web view only given new bounds leaves the part of the window it had before opaque black, a square at the
     * corner of a window that grew (measured: the window is made 10 by 10, and a 10 by 10 black square stayed at the
     * corner of the panel, over the cards, until the web view was shown again). The window is placed again only when
     * the work area changes, so the page going for a frame then is not seen.
     */
    void Fit()
    {
        if (controller == null) return;
        controller.put_IsVisible(0);
        controller.put_Bounds(new HandNative.RECT { left = 0, top = 0, right = ClientSize.Width, bottom = ClientSize.Height });
        controller.NotifyParentWindowPositionChanged();
        controller.put_IsVisible(1);
        if (keyboard) controller.MoveFocus(0); // hiding it took the focus out of the page, and a sheet's box had it
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

    // ------------------------------------------------------------------ the mouse

    /**
     * What the page says of itself, through the web view's own channel (window.chrome.webview.postMessage): where it
     * is solid, as rectangles in CSS pixels with the pixel ratio they are in. Nothing else is listened to.
     */
    void Heard(string json)
    {
        Dictionary<string, object> message;
        try { message = HandJson.Parse(json) as Dictionary<string, object>; } catch (Exception) { return; }
        object value;
        if (message == null || !message.TryGetValue("solid", out value) || !(value is List<object>)) return;
        List<object> parts = (List<object>)value;
        double scale = message.TryGetValue("dpr", out value) && value is double ? (double)value : 1;
        var made = new List<Rectangle>();
        foreach (object part in parts)
        {
            var box = part as List<object>;
            if (box == null || box.Count < 4 || !(box[0] is double && box[1] is double && box[2] is double && box[3] is double)) continue;
            int left = (int)Math.Floor((double)box[0] * scale), top = (int)Math.Floor((double)box[1] * scale);
            made.Add(new Rectangle(left, top, (int)Math.Ceiling(((double)box[0] + (double)box[2]) * scale) - left, (int)Math.Ceiling(((double)box[1] + (double)box[3]) * scale) - top));
        }
        if (solid.Length == 0 && made.Count > 0 && !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("HANDS_DEBUG"))) Console.Error.WriteLine("panel: the page is solid in " + made.Count + " places");
        solid = made.ToArray();
        Pass();
    }

    /**
     * The mouse goes through the whole window, web view and all (WS_EX_TRANSPARENT), unless the pointer is over a
     * part of the page that is solid. Looked at every 30 ms and whenever the page moves, and left as it is while a
     * button is held, so a press or a drag that has begun ends where it began.
     *
     * But while any hand holds the seat's lock, all of it lets the mouse through, wherever the pointer is and whatever
     * is held. A hand holds that lock while it borrows the mouse and keyboard (and while it waits for the user to
     * pause first), and for a guarded click into a browser window of its own. A borrow's clicks and drags are sent to
     * where the hand's window is, and the panel, on top of everything and out of every capture, is where the hand
     * cannot see it: a click sent where a card is must not land on the card (the pointer may have been resting there
     * when the borrow began, or a drag may have started under one) and open its sheet, whose box would then take the
     * borrowed typing. Until the lock is let go, the cards cannot be clicked; the on-screen hand and the voice can
     * still stop a hand.
     */
    void Pass()
    {
        bool seated = Seated();
        bool over = false;
        if (!seated)
        {
            if ((PanelNative.GetAsyncKeyState(PanelNative.VK_LBUTTON) & 0x8000) != 0 || (PanelNative.GetAsyncKeyState(PanelNative.VK_RBUTTON) & 0x8000) != 0) return;
            HandNative.POINT cursor;
            HandNative.GetCursorPos(out cursor);
            foreach (Rectangle part in solid) if (part.Contains(cursor.x - Left, cursor.y - Top)) { over = true; break; }
        }
        if (over != through) return;
        through = !over;
        int style = HandNative.GetWindowLong(Handle, HandNative.GWL_EXSTYLE);
        HandNative.SetWindowLong(Handle, HandNative.GWL_EXSTYLE, through ? style | HandNative.WS_EX_TRANSPARENT : style & ~HandNative.WS_EX_TRANSPARENT);
    }

    /**
     * Where the seat's lock is: the directory "hands-seat.lock" in the temp folder, where src/windows.ts takes it
     * (SEAT_LOCK, under os.tmpdir()). Bun finds the temp folder in TEMP, then TMP, and Windows in TMP, then TEMP: every
     * place either could have put it is looked at, which is one place when they agree, as they do.
     */
    static string[] SeatLocks()
    {
        var found = new List<string>();
        foreach (string root in new[] { Environment.GetEnvironmentVariable("TEMP"), Environment.GetEnvironmentVariable("TMP"), Path.GetTempPath() })
        {
            if (string.IsNullOrEmpty(root)) continue;
            string path;
            try { path = Path.GetFullPath(Path.Combine(root, "hands-seat.lock")); }
            catch (Exception) { continue; }
            bool known = false;
            foreach (string one in found) if (string.Equals(one, path, StringComparison.OrdinalIgnoreCase)) known = true;
            if (!known) found.Add(path);
        }
        return found.ToArray();
    }
    /** Whether a hand holds the seat's lock now. */
    bool Seated()
    {
        foreach (string path in seat) if (Directory.Exists(path)) return true;
        return false;
    }

    public void Quit()
    {
        quitting = true;
        pointer.Stop();
        try { if (controller != null) controller.Close(); } catch (Exception) { }
        controller = null;
        Application.Exit();
    }
}

static class PanelNative
{
    public const uint SWP_SHOWWINDOW = 0x40, SWP_HIDEWINDOW = 0x80, LOAD_WITH_ALTERED_SEARCH_PATH = 8;
    public const int VK_LBUTTON = 1, VK_RBUTTON = 2, WM_SETFOCUS = 0x7;
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
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
    [PreserveSig] int get_Settings(out ICoreWebView2Settings settings);
    [PreserveSig] int get_Source(out IntPtr source);
    [PreserveSig] int Navigate([MarshalAs(UnmanagedType.LPWStr)] string uri);
    [PreserveSig] int NavigateToString([MarshalAs(UnmanagedType.LPWStr)] string html);
    [PreserveSig] int add_NavigationStarting(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_NavigationStarting(WebView2Token token);
    [PreserveSig] int add_ContentLoading(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_ContentLoading(WebView2Token token);
    [PreserveSig] int add_SourceChanged(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_SourceChanged(WebView2Token token);
    [PreserveSig] int add_HistoryChanged(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_HistoryChanged(WebView2Token token);
    [PreserveSig] int add_NavigationCompleted(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_NavigationCompleted(WebView2Token token);
    [PreserveSig] int add_FrameNavigationStarting(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_FrameNavigationStarting(WebView2Token token);
    [PreserveSig] int add_FrameNavigationCompleted(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_FrameNavigationCompleted(WebView2Token token);
    [PreserveSig] int add_ScriptDialogOpening(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_ScriptDialogOpening(WebView2Token token);
    [PreserveSig] int add_PermissionRequested(IntPtr handler, out WebView2Token token);
    [PreserveSig] int remove_PermissionRequested(WebView2Token token);
    [PreserveSig] int add_ProcessFailed(IWebView2ProcessFailed handler, out WebView2Token token);
    [PreserveSig] int remove_ProcessFailed(WebView2Token token);
    [PreserveSig] int AddScriptToExecuteOnDocumentCreated(IntPtr script, IntPtr handler);
    [PreserveSig] int RemoveScriptToExecuteOnDocumentCreated(IntPtr id);
    [PreserveSig] int ExecuteScript(IntPtr script, IntPtr handler);
    [PreserveSig] int CapturePreview(int format, IntPtr stream, IntPtr handler);
    [PreserveSig] int Reload();
    [PreserveSig] int PostWebMessageAsJson(IntPtr json);
    [PreserveSig] int PostWebMessageAsString(IntPtr text);
    [PreserveSig] int add_WebMessageReceived(IWebView2MessageReceived handler, out WebView2Token token);
    [PreserveSig] int remove_WebMessageReceived(WebView2Token token);
}

[ComImport, Guid("E562E4F0-D7FA-43AC-8D71-C05150499F00"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICoreWebView2Settings
{
    [PreserveSig] int get_IsScriptEnabled(out int enabled);
    [PreserveSig] int put_IsScriptEnabled(int enabled);
    [PreserveSig] int get_IsWebMessageEnabled(out int enabled);
    [PreserveSig] int put_IsWebMessageEnabled(int enabled);
    [PreserveSig] int get_AreDefaultScriptDialogsEnabled(out int enabled);
    [PreserveSig] int put_AreDefaultScriptDialogsEnabled(int enabled);
    [PreserveSig] int get_IsStatusBarEnabled(out int enabled);
    [PreserveSig] int put_IsStatusBarEnabled(int enabled);
    [PreserveSig] int get_AreDevToolsEnabled(out int enabled);
    [PreserveSig] int put_AreDevToolsEnabled(int enabled);
    [PreserveSig] int get_AreDefaultContextMenusEnabled(out int enabled);
    [PreserveSig] int put_AreDefaultContextMenusEnabled(int enabled);
    [PreserveSig] int get_AreHostObjectsAllowed(out int allowed);
    [PreserveSig] int put_AreHostObjectsAllowed(int allowed);
    [PreserveSig] int get_IsZoomControlEnabled(out int enabled);
    [PreserveSig] int put_IsZoomControlEnabled(int enabled);
    [PreserveSig] int get_IsBuiltInErrorPageEnabled(out int enabled);
    [PreserveSig] int put_IsBuiltInErrorPageEnabled(int enabled);
}

[ComImport, Guid("FDB5AB74-AF33-4854-84F0-0A631DEB5EBA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICoreWebView2Settings3
{
    [PreserveSig] int get_IsScriptEnabled(out int enabled);
    [PreserveSig] int put_IsScriptEnabled(int enabled);
    [PreserveSig] int get_IsWebMessageEnabled(out int enabled);
    [PreserveSig] int put_IsWebMessageEnabled(int enabled);
    [PreserveSig] int get_AreDefaultScriptDialogsEnabled(out int enabled);
    [PreserveSig] int put_AreDefaultScriptDialogsEnabled(int enabled);
    [PreserveSig] int get_IsStatusBarEnabled(out int enabled);
    [PreserveSig] int put_IsStatusBarEnabled(int enabled);
    [PreserveSig] int get_AreDevToolsEnabled(out int enabled);
    [PreserveSig] int put_AreDevToolsEnabled(int enabled);
    [PreserveSig] int get_AreDefaultContextMenusEnabled(out int enabled);
    [PreserveSig] int put_AreDefaultContextMenusEnabled(int enabled);
    [PreserveSig] int get_AreHostObjectsAllowed(out int allowed);
    [PreserveSig] int put_AreHostObjectsAllowed(int allowed);
    [PreserveSig] int get_IsZoomControlEnabled(out int enabled);
    [PreserveSig] int put_IsZoomControlEnabled(int enabled);
    [PreserveSig] int get_IsBuiltInErrorPageEnabled(out int enabled);
    [PreserveSig] int put_IsBuiltInErrorPageEnabled(int enabled);
    [PreserveSig] int get_UserAgent(out IntPtr agent);
    [PreserveSig] int put_UserAgent(IntPtr agent);
    [PreserveSig] int get_AreBrowserAcceleratorKeysEnabled(out int enabled);
    [PreserveSig] int put_AreBrowserAcceleratorKeysEnabled(int enabled);
}

[ComImport, Guid("183E7052-1D03-43A0-AB99-98E043B66B39"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICoreWebView2Settings5
{
    [PreserveSig] int get_IsScriptEnabled(out int enabled);
    [PreserveSig] int put_IsScriptEnabled(int enabled);
    [PreserveSig] int get_IsWebMessageEnabled(out int enabled);
    [PreserveSig] int put_IsWebMessageEnabled(int enabled);
    [PreserveSig] int get_AreDefaultScriptDialogsEnabled(out int enabled);
    [PreserveSig] int put_AreDefaultScriptDialogsEnabled(int enabled);
    [PreserveSig] int get_IsStatusBarEnabled(out int enabled);
    [PreserveSig] int put_IsStatusBarEnabled(int enabled);
    [PreserveSig] int get_AreDevToolsEnabled(out int enabled);
    [PreserveSig] int put_AreDevToolsEnabled(int enabled);
    [PreserveSig] int get_AreDefaultContextMenusEnabled(out int enabled);
    [PreserveSig] int put_AreDefaultContextMenusEnabled(int enabled);
    [PreserveSig] int get_AreHostObjectsAllowed(out int allowed);
    [PreserveSig] int put_AreHostObjectsAllowed(int allowed);
    [PreserveSig] int get_IsZoomControlEnabled(out int enabled);
    [PreserveSig] int put_IsZoomControlEnabled(int enabled);
    [PreserveSig] int get_IsBuiltInErrorPageEnabled(out int enabled);
    [PreserveSig] int put_IsBuiltInErrorPageEnabled(int enabled);
    [PreserveSig] int get_UserAgent(out IntPtr agent);
    [PreserveSig] int put_UserAgent(IntPtr agent);
    [PreserveSig] int get_AreBrowserAcceleratorKeysEnabled(out int enabled);
    [PreserveSig] int put_AreBrowserAcceleratorKeysEnabled(int enabled);
    [PreserveSig] int get_IsPasswordAutosaveEnabled(out int enabled);
    [PreserveSig] int put_IsPasswordAutosaveEnabled(int enabled);
    [PreserveSig] int get_IsGeneralAutofillEnabled(out int enabled);
    [PreserveSig] int put_IsGeneralAutofillEnabled(int enabled);
    [PreserveSig] int get_IsPinchZoomEnabled(out int enabled);
    [PreserveSig] int put_IsPinchZoomEnabled(int enabled);
}

[ComImport, Guid("79E0AEA4-990B-42D9-AA1D-0FCC2E5BC7F1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWebView2ProcessFailed { [PreserveSig] int Invoke(IntPtr sender, IntPtr args); }

[ComImport, Guid("8155A9A4-1474-4A86-8CAE-151B0FA6B8CA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICoreWebView2ProcessFailedEventArgs { [PreserveSig] int get_ProcessFailedKind(out int kind); }

[ComImport, Guid("57213F19-00E6-49FA-8E07-898EA01ECBD2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWebView2MessageReceived { [PreserveSig] int Invoke(IntPtr sender, IntPtr args); }

[ComImport, Guid("0F99A40C-E962-4207-9E92-E3D542EFF849"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICoreWebView2WebMessageReceivedEventArgs
{
    [PreserveSig] int get_Source(out IntPtr source);
    [PreserveSig] int get_WebMessageAsJson(out IntPtr json);
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
/** Which process went away, as COREWEBVIEW2_PROCESS_FAILED_KIND numbers it; UNKNOWN when the event would not say. */
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
class WebView2ProcessFailed : IWebView2ProcessFailed
{
    public const int UNKNOWN = -1, BROWSER_EXITED = 0, RENDERER_EXITED = 1, RENDERER_HUNG = 2;
    readonly Action<int> then;
    public WebView2ProcessFailed(Action<int> then) { this.then = then; }
    public int Invoke(IntPtr sender, IntPtr args)
    {
        int kind = UNKNOWN;
        try
        {
            ICoreWebView2ProcessFailedEventArgs failed = Marshal.GetObjectForIUnknown(args) as ICoreWebView2ProcessFailedEventArgs;
            if (failed == null || failed.get_ProcessFailedKind(out kind) < 0) kind = UNKNOWN;
        }
        catch (Exception) { kind = UNKNOWN; }
        then(kind);
        return 0;
    }
}
/** A message from the page, as the JSON it was posted as. */
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
class WebView2MessageReceived : IWebView2MessageReceived
{
    readonly Action<string> then;
    public WebView2MessageReceived(Action<string> then) { this.then = then; }
    public int Invoke(IntPtr sender, IntPtr args)
    {
        string json = null;
        try
        {
            ICoreWebView2WebMessageReceivedEventArgs message = Marshal.GetObjectForIUnknown(args) as ICoreWebView2WebMessageReceivedEventArgs;
            IntPtr text;
            if (message != null && message.get_WebMessageAsJson(out text) >= 0 && text != IntPtr.Zero)
            {
                json = Marshal.PtrToStringUni(text);
                Marshal.FreeCoTaskMem(text);
            }
        }
        catch (Exception) { }
        if (json != null) then(json);
        return 0;
    }
}
