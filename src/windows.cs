// The native half of windows.ts: one process, "hands-<exe> serve", answering JSON over a named pipe.
//
// Bun calls it synchronously over bun:ffi (kernel32 WriteFile/ReadFile), so a request is one JSON object
// {cmd, ...} and its reply one JSON object, each framed as a 4-byte little-endian length. The process ends
// when the pipe breaks or its stdin closes: whichever way Bun goes, the helper goes with it, and on the way
// out puts back what the hand had out (Bun may have been killed with no chance to): a mouse button its input
// holds, the moment of a guarded click, a borrow of the seat, the windows it parked off the screens, and the
// virtual desktops it made (see Program.Leave).
//
// Built by windows.ts with the C# 5 compiler that ships in Windows (.NET Framework csc.exe), together with
// overlay.cs (the on-screen hand, dispatched as "hand"): no string interpolation, no ?., no out var, no
// expression bodies. Windows.Foundation is referenced for the OCR, so System.Drawing's Point, Size and
// Rectangle are spelled out in full.
//
// Coordinates are physical pixels everywhere: the process is per-monitor DPI aware (v2), and so is Bun.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

static class Program
{
    static volatile bool stop;
    static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    static readonly object gate = new object(); // one request at a time, and the cleanup at exit never in the middle of one

    static int Main(string[] args)
    {
        string mode = args.Length > 0 ? args[0] : "";
        if (mode == "hand") return Hand.Run(args);
        if (mode == "panel") return Panel.Run(args);
        if (mode != "serve") { Console.Error.WriteLine("usage: hands-win serve | hand | panel ..."); return 2; }
        try { Win.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
        string name = "hands-" + Process.GetCurrentProcess().Id;
        Thread watch = new Thread(delegate ()
        {
            try { Stream input = Console.OpenStandardInput(); byte[] b = new byte[64]; while (input.Read(b, 0, b.Length) > 0) { } } catch (Exception) { }
            stop = true;
            // Bun is gone, however it went. A request stuck in an app that does not answer is not waited for long.
            bool entered = false;
            try { entered = Monitor.TryEnter(gate, 3000); Leave(); }
            catch (Exception) { }
            finally { if (entered) Monitor.Exit(gate); }
            Environment.Exit(0);
        });
        watch.IsBackground = true;
        watch.Start();
        using (NamedPipeServerStream server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 1 << 16, 1 << 16))
        {
            try { Console.Out.WriteLine("ready " + name); Console.Out.Flush(); } catch (Exception) { }
            server.WaitForConnection();
            byte[] head = new byte[4];
            byte[] body = new byte[1 << 16];
            try
            {
                while (!stop)
                {
                    if (!ReadExact(server, head, 4)) break;
                    int len = BitConverter.ToInt32(head, 0);
                    if (len < 0 || len > (1 << 26)) break;
                    if (body.Length < len) body = new byte[len];
                    if (!ReadExact(server, body, len)) break;
                    string reply;
                    lock (gate)
                    {
                        try { reply = json.Serialize(Dispatch(Encoding.UTF8.GetString(body, 0, len))); }
                        catch (Exception e) { reply = json.Serialize(new Dictionary<string, object> { { "error", e.GetType().Name + ": " + e.Message } }); }
                    }
                    byte[] bytes = Encoding.UTF8.GetBytes(reply);
                    byte[] framed = new byte[4 + bytes.Length];
                    System.Buffer.BlockCopy(BitConverter.GetBytes(bytes.Length), 0, framed, 0, 4);
                    System.Buffer.BlockCopy(bytes, 0, framed, 4, bytes.Length);
                    server.Write(framed, 0, framed.Length);
                    server.Flush();
                }
            }
            catch (IOException) { }
        }
        // The pipe broke: Bun is gone, and its stdin closes with it. The watcher above sees that too, but it is a
        // background thread, which the process does not wait for once this one returns: the putting back is done here
        // as well, whichever gets to it first (see Leave).
        Leave();
        return 0;
    }

    static readonly object leaving = new object();
    static bool left;

    /**
     * Bun is gone: put back what the hand had out as it went. Any mouse button the helper's input holds is let go
     * first, then the moment of a guarded click and a borrow of the seat are undone (see Hold), the windows it parked
     * come back on screen behind the user's (see Parking), and the desktops it made go. Once: the thread that gets here
     * second waits for the first, a while, so that the process does not end in the middle of it. Nothing here throws.
     */
    static void Leave()
    {
        if (!Monitor.TryEnter(leaving, 8000)) return;
        try
        {
            if (left) return;
            left = true;
            try { Hold.Abandon(); } catch (Exception) { }
            try { Parking.ComeBack(); } catch (Exception) { }
            try { Desktops.Cleanup(); } catch (Exception) { }
        }
        finally { Monitor.Exit(leaving); }
    }

    static bool ReadExact(Stream s, byte[] b, int n)
    {
        int off = 0;
        while (off < n) { int r = s.Read(b, off, n - off); if (r <= 0) return false; off += r; }
        return true;
    }

    // ------------------------------------------------------------ request plumbing

    static Dictionary<string, object> req;
    public static string Str(string key) { object v; return req.TryGetValue(key, out v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : ""; }
    public static bool Has(string key) { object v; return req.TryGetValue(key, out v) && v != null; }
    public static long Long(string key) { object v; return req.TryGetValue(key, out v) && v != null ? Convert.ToInt64(v, CultureInfo.InvariantCulture) : 0; }
    public static int Int(string key) { return (int)Long(key); }
    static double Dbl(string key) { object v; return req.TryGetValue(key, out v) && v != null ? Convert.ToDouble(v, CultureInfo.InvariantCulture) : 0; }
    public static bool Bool(string key) { object v; return req.TryGetValue(key, out v) && v is bool && (bool)v; }
    static IntPtr Hwnd() { return new IntPtr(Long("hwnd")); }
    /** An array argument: the serializer hands one over as an ArrayList. */
    public static object[] Arr(string key)
    {
        object v;
        if (!req.TryGetValue(key, out v) || v == null) return new object[0];
        if (v is object[]) return (object[])v;
        System.Collections.IList list = v as System.Collections.IList;
        if (list == null) return new object[0];
        object[] outp = new object[list.Count];
        list.CopyTo(outp, 0);
        return outp;
    }
    static Dictionary<string, object> Ok() { return new Dictionary<string, object> { { "ok", true } }; }

    static object Dispatch(string text)
    {
        req = json.Deserialize<Dictionary<string, object>>(text);
        string cmd = Str("cmd");
        switch (cmd)
        {
            case "ping": return Ok();
            case "cursor": { Win.POINT p; Win.GetCursorPos(out p); return new object[] { p.x, p.y }; }
            case "setCursor": return Seat.SetCursor(Int("x"), Int("y"), Bool("unlessMoved"));
            case "seat": return Hold.Command(Str("state"));
            case "idle": return Seat.Idle();
            case "foreground": return Foreground();
            case "displays": return Displays();
            case "windows": return Desk.List();
            case "processes": return Processes(Str("exe"));
            case "children": return Children(Int("pid"));
            case "exe": return Exe(Int("pid"));
            case "assoc": return Assoc(Str("ext"));
            case "launch": return Launch(Str("file"), Str("args"), Has("show") ? Int("show") : 4);
            case "activate": { bool ok = Activate(Hwnd()); return new Dictionary<string, object> { { "ok", ok }, { "foreground", Win.GetForegroundWindow().ToInt64() } }; }
            case "move": return Move();
            case "park": return Parking.Park(Hwnd());
            case "unpark": return Parking.Unpark(Hwnd(), Bool("keep"));
            case "show": Win.ShowWindow(Hwnd(), Win.IsIconic(Hwnd()) ? 4 : 8); return Ok();
            case "close": Win.PostMessage(Hwnd(), 0x0010, IntPtr.Zero, IntPtr.Zero); return Ok();
            case "topmost": Win.SetWindowPos(Hwnd(), new IntPtr(Bool("on") ? -1 : -2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); return Ok();
            case "sink": Win.SetWindowPos(Hwnd(), new IntPtr(1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); return Ok(); // HWND_BOTTOM: behind every window of the user's, without activation
            case "capture": return Capture.Take();
            case "colours": return Capture.Colours(Hwnd(), Has("cap") ? Int("cap") : 64);
            case "image": return Capture.Size(Str("path"));
            case "ocr": return Ocr.Read(Str("path"), Arr("rect"));
            case "tree": return Uia.Tree(Hwnd(), Has("cap") ? Int("cap") : 4000, Has("ms") ? Int("ms") : 600);
            case "focused": return Uia.Focused();
            case "act": return Uia.Act(Int("id"), Str("action"), !Has("sink") || Bool("sink"));
            case "setValue": return Uia.SetValue(Int("id"), Str("text"), !Has("sink") || Bool("sink"));
            case "value": return Uia.Value(Int("id"));
            case "release": Uia.Release(); return Ok();
            case "post": return Input.Post(Hwnd(), Str("kind"), Int("x"), Int("y"));
            case "guard": if (Bool("begin")) { Flash.Driven(Hwnd(), !Has("sink") || Bool("sink")); return Ok(); } return Flash.EndDriven();
            case "chars": return Input.Chars(Hwnd(), Str("text"), Bool("direct"));
            case "vkey": return Input.VKey(Hwnd(), Int("vk"), Bool("direct"));
            case "wheel": return Input.Wheel(Hwnd(), Int("x"), Int("y"), Int("delta"), Bool("horizontal"));
            case "input": return Input.Send();
            case "clipboard": return Clipboard(Str("text"));
            case "browser": return Uia.Browser(Hwnd());
            case "web": return new Dictionary<string, object> { { "web", Web.OfProcess((uint)Int("pid")) } };
            case "menu": return Uia.Menu(Hwnd(), Arr("path"));
            case "scrollPage": return Uia.ScrollPage(Hwnd(), Str("direction"));
            case "reg": return Reg(Str("key"), Str("name"));
            case "desktop": return Desktops.Try(delegate { return Desktops.Ensure(Str("name")); });
            case "desktops": return Desktops.Try(delegate { return Desktops.Names(); });
            case "send": return Desktops.Try(delegate { return Desktops.Send(Str("name"), Hwnd()); });
            case "recall": return Desktops.Try(delegate { VirtualDesktop.Desktop.Current.MoveWindow(Hwnd(), true); return Ok(); }); // back to the desktop on screen, wherever it was
            case "onDesktop": return Desktops.Try(delegate { return Desktops.Has(Str("name"), Hwnd()); });
            case "removeDesktop": return Desktops.Try(delegate { return Desktops.Remove(Str("name")); });
            case "removeDesktops": return Desktops.Try(delegate { return Desktops.RemoveAll(Str("prefix")); });
            case "switch": return Desktops.Try(delegate { Desktops.Need(Str("name")).MakeVisible(); return Ok(); });
            default: throw new ArgumentException("unknown command " + cmd);
        }
    }

    // ------------------------------------------------------------ the desktop

    static object Foreground()
    {
        IntPtr h = Win.GetForegroundWindow();
        Desk.Entry e = Desk.Describe(h);
        return new Dictionary<string, object> { { "hwnd", h.ToInt64() }, { "pid", e.pid }, { "cls", e.cls }, { "title", e.title } };
    }

    static object Displays()
    {
        List<object> outp = new List<object>();
        System.Windows.Forms.Screen[] screens = System.Windows.Forms.Screen.AllScreens;
        // The primary display first: it is the one whose top-left is the origin, as the Mac's main display is.
        Array.Sort(screens, delegate (System.Windows.Forms.Screen a, System.Windows.Forms.Screen b) { return (b.Primary ? 1 : 0) - (a.Primary ? 1 : 0); });
        for (int i = 0; i < screens.Length; i++)
        {
            System.Drawing.Rectangle r = screens[i].Bounds;
            outp.Add(new Dictionary<string, object> { { "index", i }, { "frame", new object[] { r.X, r.Y, r.Width, r.Height } }, { "device", screens[i].DeviceName } });
        }
        return outp;
    }

    /**
     * Main processes of one executable, with their command lines: WMI is the one API that reads another process's
     * arguments without debugging it. Its Name is the file name alone, so a full path is asked for by its file name,
     * and a WQL string escapes backslashes and quotes with a backslash.
     */
    static object Processes(string exe)
    {
        List<object> outp = new List<object>();
        string name = Path.GetFileName(exe);
        string query = "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = '" + name.Replace("\\", "\\\\").Replace("'", "\\'") + "'";
        using (System.Management.ManagementObjectSearcher searcher = new System.Management.ManagementObjectSearcher(query))
        {
            foreach (System.Management.ManagementObject p in searcher.Get())
            {
                object cmd = p["CommandLine"];
                outp.Add(new Dictionary<string, object> { { "pid", Convert.ToInt64(p["ProcessId"]) }, { "cmd", cmd == null ? "" : cmd.ToString() } });
            }
        }
        return outp;
    }

    static object Exe(int pid)
    {
        string path = Desk.ImageOf((uint)pid);
        if (path.Length == 0) { try { path = Process.GetProcessById(pid).ProcessName + ".exe"; } catch (Exception) { } }
        return new Dictionary<string, object> { { "name", Path.GetFileNameWithoutExtension(path) }, { "path", path } };
    }

    /** Every process started by `pid`, and by those, as far down as it goes: an app's launcher can hand over to a child. */
    static object Children(int pid)
    {
        Dictionary<uint, List<uint>> kids = new Dictionary<uint, List<uint>>();
        IntPtr snap = Win.CreateToolhelp32Snapshot(0x2, 0); // TH32CS_SNAPPROCESS
        if (snap == new IntPtr(-1)) return new object[0];
        try
        {
            Win.PROCESSENTRY32 e = new Win.PROCESSENTRY32();
            e.dwSize = (uint)Marshal.SizeOf(typeof(Win.PROCESSENTRY32));
            for (bool more = Win.Process32First(snap, ref e); more; more = Win.Process32Next(snap, ref e))
            {
                List<uint> list;
                if (!kids.TryGetValue(e.th32ParentProcessID, out list)) kids[e.th32ParentProcessID] = list = new List<uint>();
                if (e.th32ProcessID != e.th32ParentProcessID) list.Add(e.th32ProcessID);
            }
        }
        finally { Win.CloseHandle(snap); }
        List<object> outp = new List<object>();
        List<uint> queue = new List<uint>();
        queue.Add((uint)pid);
        for (int i = 0; i < queue.Count && queue.Count < 512; i++)
        {
            List<uint> list;
            if (!kids.TryGetValue(queue[i], out list)) continue;
            foreach (uint kid in list) if (!queue.Contains(kid)) { queue.Add(kid); outp.Add((long)kid); }
        }
        return outp;
    }

    /** The executable that opens a kind of file ("xlsx", ".txt"), by its file name, or "" when the shell names none. */
    static object Assoc(string ext)
    {
        if (!ext.StartsWith(".")) ext = "." + ext;
        StringBuilder b = new StringBuilder(1024);
        uint n = 1024;
        string exe = Win.AssocQueryString(0, 2, ext, "open", b, ref n) == 0 ? Path.GetFileName(b.ToString()) : ""; // ASSOCSTR_EXECUTABLE
        return new Dictionary<string, object> { { "exe", exe } };
    }

    /**
     * ShellExecuteEx with SW_SHOWNOACTIVATE: the app opens without the foreground moving. The pid can be a stub's (notepad,
     * calc), so its executable is said too, and a shortcut's target: what the window that opens will belong to.
     */
    static object Launch(string file, string args, int show)
    {
        Win.SHELLEXECUTEINFO info = new Win.SHELLEXECUTEINFO();
        info.cbSize = Marshal.SizeOf(typeof(Win.SHELLEXECUTEINFO));
        info.fMask = 0x40 | 0x100 | 0x400; // NOCLOSEPROCESS | NOASYNC | FLAG_NO_UI
        info.lpFile = file;
        info.lpParameters = args;
        info.nShow = show;
        if (!Win.ShellExecuteEx(ref info)) throw new Exception("cannot start " + file + " (error " + Marshal.GetLastWin32Error() + ")");
        int pid = 0;
        string exe = "";
        if (info.hProcess != IntPtr.Zero)
        {
            pid = Win.GetProcessId(info.hProcess);
            exe = Path.GetFileName(Desk.ImageOf(info.hProcess));
            Win.CloseHandle(info.hProcess);
        }
        string target = file.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase) ? Path.GetFileName(ShortcutTarget(file)) : "";
        return new Dictionary<string, object> { { "pid", pid }, { "exe", exe }, { "target", target } };
    }

    /** What a shortcut starts, through the shell's own scripting object; "" for one that names no file (a packaged app's). */
    static string ShortcutTarget(string path)
    {
        try
        {
            Type type = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(type);
            object link = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
            object target = link.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, link, null);
            return target as string ?? "";
        }
        catch (Exception) { return ""; }
    }

    /**
     * Bring a window to the front. SetForegroundWindow from a process that is not in front is refused; attached to the
     * input queue of the thread that is, it is allowed. Measured live on this machine: that is how the seat is handed back.
     * After the user has been idle a long while it fails even so, unless input came first: a move of the cursor to where
     * it is, which moves nothing (measured: 20 of 20 with it, two failures in a few without).
     */
    public static bool Activate(IntPtr hwnd)
    {
        if (Win.IsIconic(hwnd)) Win.ShowWindow(hwnd, 9);
        if (Win.GetForegroundWindow() == hwnd) return true;
        Input.Nudge();
        bool ok = Win.SetForegroundWindow(hwnd);
        if (!ok || Win.GetForegroundWindow() != hwnd)
        {
            uint pid; uint fgThread = Win.GetWindowThreadProcessId(Win.GetForegroundWindow(), out pid);
            uint me = Win.GetCurrentThreadId();
            if (fgThread != 0 && fgThread != me) Win.AttachThreadInput(me, fgThread, true);
            ok = Win.SetForegroundWindow(hwnd);
            if (fgThread != 0 && fgThread != me) Win.AttachThreadInput(me, fgThread, false);
        }
        Thread.Sleep(50);
        return Win.GetForegroundWindow() == hwnd;
    }

    static object Move()
    {
        uint flags = 0x0004 | 0x0010; // NOZORDER | NOACTIVATE
        if (!Has("w")) flags |= 0x0001; // NOSIZE
        bool ok = Win.SetWindowPos(Hwnd(), IntPtr.Zero, Int("x"), Int("y"), Int("w"), Int("h"), flags);
        return new Dictionary<string, object> { { "ok", ok } };
    }

    /** One registry value under HKCU then HKLM (`key` is the path below either hive), as a string, or null when neither has it. */
    static object Reg(string key, string name)
    {
        object value = null;
        try { value = Microsoft.Win32.Registry.GetValue("HKEY_CURRENT_USER\\" + key, name, null); } catch (Exception) { }
        if (value == null) { try { value = Microsoft.Win32.Registry.GetValue("HKEY_LOCAL_MACHINE\\" + key, name, null); } catch (Exception) { } }
        return new Dictionary<string, object> { { "value", value == null ? null : Convert.ToString(value, CultureInfo.InvariantCulture) } };
    }

    static object Clipboard(string text)
    {
        Exception failure = null;
        Thread t = new Thread(delegate () { try { System.Windows.Forms.Clipboard.SetText(text.Length == 0 ? " " : text); } catch (Exception e) { failure = e; } });
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join(3000);
        if (failure != null) throw failure;
        return Ok();
    }
}

// ------------------------------------------------------------ windows

static class Desk
{
    public struct Entry { public IntPtr hwnd, core; public uint pid; public string cls, title; public Win.RECT frame; }

    public static string ClassOf(IntPtr h) { StringBuilder b = new StringBuilder(256); Win.GetClassName(h, b, 256); return b.ToString(); }
    public static string TitleOf(IntPtr h) { StringBuilder b = new StringBuilder(1024); Win.GetWindowText(h, b, 1024); return b.ToString(); }
    public static uint PidOf(IntPtr h) { uint p; Win.GetWindowThreadProcessId(h, out p); return p; }
    public static Win.RECT Frame(IntPtr h) { Win.RECT r; if (Win.DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(Win.RECT))) != 0) Win.GetWindowRect(h, out r); return r; }
    static int Cloaked(IntPtr h) { int c; return Win.DwmGetWindowAttribute(h, 14, out c, 4) == 0 ? c : 0; }

    /** A UWP app is two windows: the ApplicationFrameWindow (ApplicationFrameHost's) and the app's own CoreWindow inside it. */
    public static IntPtr CoreOf(IntPtr frame)
    {
        IntPtr core = IntPtr.Zero;
        Win.EnumChildWindows(frame, delegate (IntPtr c, IntPtr l) { if (ClassOf(c) == "Windows.UI.Core.CoreWindow") core = c; return core == IntPtr.Zero; }, IntPtr.Zero);
        return core;
    }

    public static Entry Describe(IntPtr h)
    {
        Entry e = new Entry();
        e.hwnd = h;
        e.cls = ClassOf(h);
        e.title = TitleOf(h);
        e.pid = PidOf(h);
        e.frame = Frame(h);
        if (e.cls == "ApplicationFrameWindow") { e.core = CoreOf(h); if (e.core != IntPtr.Zero) e.pid = PidOf(e.core); }
        return e;
    }

    /** The full path of a process's executable, or "" when it cannot be opened. */
    public static string ImageOf(uint pid)
    {
        IntPtr h = Win.OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (h == IntPtr.Zero) return "";
        try { return ImageOf(h); }
        finally { Win.CloseHandle(h); }
    }

    public static string ImageOf(IntPtr process)
    {
        StringBuilder b = new StringBuilder(1024);
        int n = 1024;
        return Win.QueryFullProcessImageName(process, 0, b, ref n) ? b.ToString(0, n) : "";
    }

    /** A process's executable by file name and its package family ("" for an app that is not packaged). */
    static string[] ProcessOf(uint pid)
    {
        IntPtr h = Win.OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) return new string[] { "", "" };
        try
        {
            StringBuilder family = new StringBuilder(256);
            uint n = 256;
            string package = Win.GetPackageFamilyName(h, ref n, family) == 0 ? family.ToString() : "";
            return new string[] { Path.GetFileName(ImageOf(h)), package };
        }
        finally { Win.CloseHandle(h); }
    }

    /** Where a minimized window goes back to, its restored frame: its frame on screen is a caption parked off every display. */
    static Win.RECT Restored(IntPtr h)
    {
        Win.WINDOWPLACEMENT p = new Win.WINDOWPLACEMENT();
        p.length = Marshal.SizeOf(typeof(Win.WINDOWPLACEMENT));
        Win.GetWindowPlacement(h, ref p);
        return p.rcNormalPosition;
    }

    /**
     * Ordinary windows front to back: visible, not a tool window, bigger than a palette (a minimized one by its restored
     * size), not the shell's. A window the shell cloaks because it lies on another virtual desktop (DWM_CLOAKED_SHELL) is
     * listed with `cloaked` true: a hand's own window on the hand's desktop. Any other cloaked window (a suspended UWP
     * app's) is left out. Each says what owns it (a dialog, its window), whether it takes input (a window under a modal
     * dialog does not), whether it is minimized, whether it has a title bar or is a bare popup (a splash screen), and the
     * executable and package of its process, which is how a window is known for the app that was started.
     */
    public static object List()
    {
        List<object> outp = new List<object>();
        Dictionary<uint, string[]> processes = new Dictionary<uint, string[]>();
        for (IntPtr h = Win.GetTopWindow(IntPtr.Zero); h != IntPtr.Zero; h = Win.GetWindow(h, 2))
        {
            if (!Win.IsWindowVisible(h)) continue;
            int cloaked = Cloaked(h);
            if ((Win.GetWindowLongPtr(h, -20).ToInt64() & 0x80) != 0 || (cloaked != 0 && cloaked != 2)) continue;
            bool iconic = Win.IsIconic(h);
            Win.RECT r = iconic ? Restored(h) : Frame(h);
            if (r.R - r.L <= 50 || r.B - r.T <= 50) continue;
            string cls = ClassOf(h);
            if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") continue;
            Entry e = Describe(h);
            string[] process;
            if (!processes.TryGetValue(e.pid, out process)) processes[e.pid] = process = ProcessOf(e.pid);
            long style = Win.GetWindowLongPtr(h, -16).ToInt64();
            outp.Add(new Dictionary<string, object> {
                { "hwnd", h.ToInt64() }, { "pid", e.pid }, { "cls", cls }, { "title", e.title },
                { "frame", new object[] { r.L, r.T, r.R - r.L, r.B - r.T } }, { "core", e.core.ToInt64() }, { "cloaked", cloaked != 0 },
                { "owner", Win.GetWindow(h, 4).ToInt64() }, { "enabled", Win.IsWindowEnabled(h) }, { "iconic", iconic },
                { "caption", (style & 0x00C00000L) == 0x00C00000L }, { "popup", (style & 0x80000000L) != 0 },
                { "exe", process[0] }, { "package", process[1] },
            });
        }
        return outp;
    }
}

// ------------------------------------------------------------ virtual desktops

/**
 * A desktop per hand, through the shell's internal interfaces (src/vendor/VirtualDesktop11-24H2.cs): the public
 * IVirtualDesktopManager moves only its own process's windows. Those interfaces live in Explorer, and die with it: a
 * call that finds them disconnected connects again and is made once more. The desktops made here, and the windows
 * sent to them, are remembered, so that the helper can take them down as it exits however its parent went.
 */
static class Desktops
{
    static readonly List<string> made = new List<string>();
    static readonly List<IntPtr> sent = new List<IntPtr>();

    public delegate object Call();

    public static object Try(Call call)
    {
        try { return call(); }
        catch (Exception e)
        {
            if (!Disconnected(e)) throw;
            VirtualDesktop.DesktopManager.Reconnect();
            return call();
        }
    }

    /** RPC_E_DISCONNECTED and the RPC server's absence or failure (Explorer restarted), or a connection never made. */
    static bool Disconnected(Exception e)
    {
        for (Exception at = e; at != null; at = at.InnerException)
        {
            if (at is NullReferenceException) return true;
            uint code = (uint)Marshal.GetHRForException(at);
            if (code == 0x80010108 || code == 0x800706BA || code == 0x800706BF) return true;
        }
        return false;
    }

    static VirtualDesktop.Desktop Find(string name)
    {
        for (int i = 0; i < VirtualDesktop.Desktop.Count; i++) if (VirtualDesktop.Desktop.DesktopNameFromIndex(i) == name) return VirtualDesktop.Desktop.FromIndex(i);
        return null;
    }

    public static VirtualDesktop.Desktop Need(string name)
    {
        VirtualDesktop.Desktop d = Find(name);
        if (d == null) throw new Exception("no virtual desktop named " + name);
        return d;
    }

    /** The desktop by that name, made if there is none: {index, created}. Making one does not switch to it. */
    public static object Ensure(string name)
    {
        VirtualDesktop.Desktop d = Find(name);
        bool created = d == null;
        if (created)
        {
            d = VirtualDesktop.Desktop.Create();
            d.SetName(name);
            if (!made.Contains(name)) made.Add(name);
        }
        return new Dictionary<string, object> { { "index", VirtualDesktop.Desktop.FromDesktop(d) }, { "created", created } };
    }

    public static object Send(string name, IntPtr hwnd)
    {
        Need(name).MoveWindow(hwnd, true);
        if (!sent.Contains(hwnd)) sent.Add(hwnd);
        return new Dictionary<string, object> { { "ok", true } };
    }

    /**
     * Take down every desktop whose name starts with `prefix` (what runs that died left behind), with whatever is on
     * them brought to the desktop on screen and put behind the user's windows, not dropped over them: {removed}.
     */
    public static object RemoveAll(string prefix)
    {
        int removed = 0;
        for (int i = VirtualDesktop.Desktop.Count - 1; i >= 0; i--)
        {
            string name = VirtualDesktop.Desktop.DesktopNameFromIndex(i);
            if (prefix.Length == 0 || name == null || !name.StartsWith(prefix, StringComparison.Ordinal)) continue;
            VirtualDesktop.Desktop d = VirtualDesktop.Desktop.FromIndex(i);
            for (IntPtr h = Win.GetTopWindow(IntPtr.Zero); h != IntPtr.Zero; h = Win.GetWindow(h, 2)) Bring(d, h);
            Remove(name);
            removed++;
        }
        return new Dictionary<string, object> { { "removed", removed } };
    }

    /** A window on desktop `d` moved to the one on screen and sunk; nothing for a window elsewhere, or gone. */
    static void Bring(VirtualDesktop.Desktop d, IntPtr h)
    {
        try
        {
            if (!Win.IsWindow(h) || !Win.IsWindowVisible(h) || !d.HasWindow(h)) return;
            VirtualDesktop.Desktop.Current.MoveWindow(h, true);
            Win.SetWindowPos(h, new IntPtr(1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
        }
        catch (Exception) { }
    }

    /** As the helper exits: the windows it sent come back behind the user's, and the desktops it made go. Nothing here throws. */
    public static void Cleanup()
    {
        foreach (string name in made.ToArray())
        {
            try
            {
                Try(delegate
                {
                    VirtualDesktop.Desktop d = Find(name);
                    if (d == null) return null;
                    foreach (IntPtr h in sent) Bring(d, h);
                    return Remove(name);
                });
            }
            catch (Exception) { }
        }
        made.Clear();
    }

    public static object Names()
    {
        List<object> names = new List<object>();
        for (int i = 0; i < VirtualDesktop.Desktop.Count; i++) names.Add(VirtualDesktop.Desktop.DesktopNameFromIndex(i));
        return names;
    }

    /**
     * Whether a window lies on the desktop by that name, by the shell's own account: {on}. A window on the desktop
     * the user has switched to is on it and not cloaked, so the cloak cannot tell. On no desktop when the name is gone,
     * and an error for a window that is gone (the shell has no view for it).
     */
    public static object Has(string name, IntPtr hwnd)
    {
        VirtualDesktop.Desktop d = Find(name);
        return new Dictionary<string, object> { { "on", d != null && d.HasWindow(hwnd) } };
    }

    /** Remove the desktop by that name; its windows land on the current desktop (or on the first other one, if the user is looking at it). */
    public static object Remove(string name)
    {
        VirtualDesktop.Desktop d = Find(name);
        if (d == null) return new Dictionary<string, object> { { "removed", false } };
        int index = VirtualDesktop.Desktop.FromDesktop(d);
        VirtualDesktop.Desktop fallback = VirtualDesktop.Desktop.Current;
        if (VirtualDesktop.Desktop.FromDesktop(fallback) == index) fallback = VirtualDesktop.Desktop.FromIndex(index == 0 ? 1 : 0);
        d.Remove(fallback);
        made.Remove(name);
        return new Dictionary<string, object> { { "removed", true } };
    }
}

// ------------------------------------------------------------ capture

static class Capture
{
    static string loadedPath;
    static System.Drawing.Bitmap loaded;

    /** The capture at `path`, decoded once and kept: the OCR that follows crops from it. */
    public static System.Drawing.Bitmap Load(string path)
    {
        if (loadedPath == path && loaded != null) return loaded;
        System.Drawing.Bitmap fresh;
        using (System.Drawing.Image image = System.Drawing.Image.FromStream(new MemoryStream(File.ReadAllBytes(path)))) fresh = new System.Drawing.Bitmap(image);
        Keep(path, fresh);
        return loaded;
    }

    /** A picture just written to `path`, kept as if it had been read back: the OCR that follows a capture needs no decode. */
    static void Keep(string path, System.Drawing.Bitmap picture)
    {
        if (loaded != null && loaded != picture) loaded.Dispose();
        loaded = picture;
        loadedPath = path;
    }

    public static object Size(string path)
    {
        System.Drawing.Bitmap b = Load(path);
        return new Dictionary<string, object> { { "width", b.Width }, { "height", b.Height } };
    }

    /**
     * One window by PrintWindow(PW_RENDERFULLCONTENT), which DWM renders whole whether or not other windows cover it,
     * cropped to the frame the user sees. A minimized window has nothing to render: with `restore` it is restored
     * (without activation) first, and without, there is no picture (null) and it stays minimized.
     */
    static System.Drawing.Bitmap Window(IntPtr hwnd, bool restore)
    {
        if (Win.IsIconic(hwnd))
        {
            if (!restore) return null;
            Win.ShowWindow(hwnd, 4);
            Thread.Sleep(400);
        }
        Win.RECT wr; Win.GetWindowRect(hwnd, out wr);
        Win.RECT fr = Desk.Frame(hwnd);
        int w = Math.Max(1, wr.R - wr.L), h = Math.Max(1, wr.B - wr.T);
        Win.BITMAPINFOHEADER bi = new Win.BITMAPINFOHEADER();
        bi.biSize = 40; bi.biWidth = w; bi.biHeight = -h; bi.biPlanes = 1; bi.biBitCount = 32;
        IntPtr screen = Win.GetDC(IntPtr.Zero);
        IntPtr dc = Win.CreateCompatibleDC(screen);
        IntPtr bits;
        IntPtr dib = Win.CreateDIBSection(screen, ref bi, 0, out bits, IntPtr.Zero, 0);
        Win.ReleaseDC(IntPtr.Zero, screen);
        IntPtr old = Win.SelectObject(dc, dib);
        try
        {
            if (!Win.PrintWindow(hwnd, dc, 2)) throw new Exception("PrintWindow failed for window " + hwnd.ToInt64());
            using (System.Drawing.Bitmap whole = new System.Drawing.Bitmap(w, h, w * 4, PixelFormat.Format32bppArgb, bits))
            {
                System.Drawing.Rectangle crop = System.Drawing.Rectangle.Intersect(new System.Drawing.Rectangle(0, 0, w, h), new System.Drawing.Rectangle(fr.L - wr.L, fr.T - wr.T, fr.R - fr.L, fr.B - fr.T));
                if (crop.Width < 1 || crop.Height < 1) crop = new System.Drawing.Rectangle(0, 0, w, h);
                return whole.Clone(crop, PixelFormat.Format32bppRgb);
            }
        }
        finally { Win.SelectObject(dc, old); Win.DeleteObject(dib); Win.DeleteDC(dc); }
    }

    /**
     * How many distinct colours a window paints, sampled every fourth pixel and counted up to `cap`, and whether it is
     * blank (see Blank): a frame that has stopped drawing (a UWP app on a desktop that is not shown) is one colour, and
     * no file is worth writing to learn that.
     */
    public static object Colours(IntPtr hwnd, int cap)
    {
        HashSet<int> seen = new HashSet<int>();
        bool blank;
        using (System.Drawing.Bitmap shot = Window(hwnd, true))
        {
            BitmapData data = shot.LockBits(new System.Drawing.Rectangle(0, 0, shot.Width, shot.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
            try
            {
                for (int y = 0; y < shot.Height && seen.Count < cap; y += 4)
                    for (int x = 0; x < shot.Width && seen.Count < cap; x += 4)
                        seen.Add(Marshal.ReadInt32(data.Scan0, y * data.Stride + x * 4) & 0xffffff);
            }
            finally { shot.UnlockBits(data); }
            blank = Blank(shot, TitleBar(hwnd));
        }
        return new Dictionary<string, object> { { "colours", seen.Count }, { "blank", blank } };
    }

    /**
     * Whether a picture shows nothing: one colour, give or take its lowest bits, over more than 97% of it below the
     * title bar, sampled every sixth pixel. A window that has stopped drawing is black or one flat colour there, while
     * its title bar can still carry the glyphs that fooled a count of colours (a blank ChatGPT window passed one).
     */
    static bool Blank(System.Drawing.Bitmap shot, int skip)
    {
        Dictionary<int, int> counts = new Dictionary<int, int>();
        int total = 0, top = 0;
        BitmapData data = shot.LockBits(new System.Drawing.Rectangle(0, 0, shot.Width, shot.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
        try
        {
            for (int y = Math.Min(Math.Max(0, skip), shot.Height - 1); y < shot.Height; y += 6)
                for (int x = 0; x < shot.Width; x += 6)
                {
                    int colour = Marshal.ReadInt32(data.Scan0, y * data.Stride + x * 4) & 0xf8f8f8;
                    int n;
                    counts.TryGetValue(colour, out n);
                    counts[colour] = ++n;
                    if (n > top) top = n;
                    total++;
                }
        }
        finally { shot.UnlockBits(data); }
        return total > 0 && top > total * 0.97;
    }

    /** The height of a window's title bar, in the picture's pixels: where the caption buttons end, or a standard one at the window's scale. */
    static int TitleBar(IntPtr hwnd)
    {
        Win.RECT buttons;
        if (Win.DwmGetWindowAttribute(hwnd, 5, out buttons, Marshal.SizeOf(typeof(Win.RECT))) == 0 && buttons.B > 0 && buttons.B < 200) return buttons.B; // DWMWA_CAPTION_BUTTON_BOUNDS
        uint dpi = 96;
        try { dpi = Math.Max(96u, Win.GetDpiForWindow(hwnd)); } catch (Exception) { }
        return (int)(32 * dpi / 96);
    }

    /** A picture `width` wide, scaled down smoothly: a thumbnail of a window is read by a person. */
    static System.Drawing.Bitmap Resize(System.Drawing.Bitmap from, int width)
    {
        int height = Math.Max(1, from.Height * width / from.Width);
        System.Drawing.Bitmap to = new System.Drawing.Bitmap(width, height, PixelFormat.Format32bppRgb);
        using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(to))
        using (ImageAttributes edges = new ImageAttributes())
        {
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
            edges.SetWrapMode(System.Drawing.Drawing2D.WrapMode.TileFlipXY); // no dark seam where the filter reads past the edge
            g.DrawImage(from, new System.Drawing.Rectangle(0, 0, width, height), 0, 0, from.Width, from.Height, System.Drawing.GraphicsUnit.Pixel, edges);
        }
        return to;
    }

    static void Save(System.Drawing.Bitmap picture, Stream to, string format)
    {
        if (format != "jpeg") { picture.Save(to, ImageFormat.Png); return; }
        ImageCodecInfo codec = null;
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
        EncoderParameters p = new EncoderParameters(1);
        p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 80L);
        picture.Save(to, codec, p);
    }

    /**
     * A window, or one display by BitBlt, as a PNG or JPEG: written to `path`, and kept for the OCR that follows, or with
     * `inline`, handed back in the reply as base64 (a thumbnail, with no file to write and read back). A window can be
     * gone ({gone}), or minimized and not to be restored ({minimized}); `blank` says a window's picture shows nothing.
     */
    public static object Take()
    {
        string path = Program.Str("path");
        string format = Program.Str("format");
        int max = Program.Int("max");
        bool restore = !Program.Has("restore") || Program.Bool("restore");
        System.Drawing.Bitmap shot;
        bool blank = false;
        if (Program.Has("hwnd"))
        {
            IntPtr hwnd = new IntPtr(Program.Long("hwnd"));
            if (!Win.IsWindow(hwnd)) return new Dictionary<string, object> { { "gone", true } };
            shot = Window(hwnd, restore);
            if (shot == null) return new Dictionary<string, object> { { "minimized", true } };
            blank = Blank(shot, TitleBar(hwnd));
        }
        else
        {
            System.Windows.Forms.Screen[] screens = System.Windows.Forms.Screen.AllScreens;
            Array.Sort(screens, delegate (System.Windows.Forms.Screen a, System.Windows.Forms.Screen b) { return (b.Primary ? 1 : 0) - (a.Primary ? 1 : 0); });
            int index = Math.Min(Program.Int("display"), screens.Length - 1);
            System.Drawing.Rectangle r = screens[Math.Max(0, index)].Bounds;
            shot = new System.Drawing.Bitmap(r.Width, r.Height, PixelFormat.Format32bppRgb);
            using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(shot)) g.CopyFromScreen(r.Left, r.Top, 0, 0, r.Size, System.Drawing.CopyPixelOperation.SourceCopy);
        }
        System.Drawing.Bitmap saved = shot;
        if (max > 0 && shot.Width > max)
        {
            saved = Resize(shot, max);
            shot.Dispose();
        }
        Dictionary<string, object> reply = new Dictionary<string, object> { { "width", saved.Width }, { "height", saved.Height }, { "blank", blank } };
        if (Program.Bool("inline"))
        {
            using (saved)
            using (MemoryStream bytes = new MemoryStream())
            {
                Save(saved, bytes, format);
                reply["bytes"] = Convert.ToBase64String(bytes.ToArray());
            }
            return reply;
        }
        try
        {
            using (FileStream file = File.Create(path)) Save(saved, file, format);
        }
        catch (Exception)
        {
            saved.Dispose();
            throw;
        }
        Keep(path, saved);
        return reply;
    }
}

// ------------------------------------------------------------ OCR

static class Ocr
{
    static OcrEngine engine;

    static Task<T> AsTask<T>(IAsyncOperation<T> op)
    {
        TaskCompletionSource<T> tcs = new TaskCompletionSource<T>();
        op.Completed = delegate (IAsyncOperation<T> info, AsyncStatus status)
        {
            try
            {
                if (status == AsyncStatus.Completed) tcs.SetResult(info.GetResults());
                else if (status == AsyncStatus.Canceled) tcs.SetCanceled();
                else tcs.SetException(info.ErrorCode ?? new Exception("WinRT async failed: " + status));
            }
            catch (Exception ex) { tcs.SetException(ex); }
            finally { info.Close(); }
        };
        return tcs.Task;
    }

    static SoftwareBitmap ToSoftware(System.Drawing.Bitmap bmp)
    {
        BitmapData data = bmp.LockBits(new System.Drawing.Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
        try
        {
            byte[] bytes = new byte[data.Stride * bmp.Height];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            DataWriter writer = new DataWriter();
            writer.WriteBytes(bytes);
            return SoftwareBitmap.CreateCopyFromBuffer(writer.DetachBuffer(), BitmapPixelFormat.Bgra8, bmp.Width, bmp.Height, BitmapAlphaMode.Premultiplied);
        }
        finally { bmp.UnlockBits(data); }
    }

    /** Lines of one rectangle of a capture, boxes relative to that rectangle: [[text, confidence, [x1, y1, x2, y2]], ...]. */
    public static object Read(string path, object[] rect)
    {
        if (engine == null) engine = OcrEngine.TryCreateFromLanguage(new Language("en-US")) ?? OcrEngine.TryCreateFromUserProfileLanguages();
        if (engine == null) throw new Exception("no OCR language is installed");
        System.Drawing.Bitmap full = Capture.Load(path);
        System.Drawing.Rectangle crop = rect.Length == 4
            ? new System.Drawing.Rectangle(Convert.ToInt32(rect[0]), Convert.ToInt32(rect[1]), Convert.ToInt32(rect[2]) - Convert.ToInt32(rect[0]), Convert.ToInt32(rect[3]) - Convert.ToInt32(rect[1]))
            : new System.Drawing.Rectangle(0, 0, full.Width, full.Height);
        crop = System.Drawing.Rectangle.Intersect(crop, new System.Drawing.Rectangle(0, 0, full.Width, full.Height));
        List<object> lines = new List<object>();
        if (crop.Width < 2 || crop.Height < 2) return lines;
        // The engine wants a picture bigger than a word and no side longer than it takes; a sliver is padded, a wall is shrunk.
        double scale = Math.Min(1.0, Math.Min((double)OcrEngine.MaxImageDimension / crop.Width, (double)OcrEngine.MaxImageDimension / crop.Height));
        int w = Math.Max(64, (int)(crop.Width * scale)), h = Math.Max(64, (int)(crop.Height * scale));
        using (System.Drawing.Bitmap canvas = new System.Drawing.Bitmap(w, h, PixelFormat.Format32bppPArgb))
        {
            using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(canvas))
            {
                g.Clear(System.Drawing.Color.White);
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.DrawImage(full, new System.Drawing.Rectangle(0, 0, (int)(crop.Width * scale), (int)(crop.Height * scale)), crop, System.Drawing.GraphicsUnit.Pixel);
            }
            SoftwareBitmap soft = ToSoftware(canvas);
            OcrResult result;
            try { result = AsTask(engine.RecognizeAsync(soft)).GetAwaiter().GetResult(); }
            finally { soft.Dispose(); }
            foreach (OcrLine line in result.Lines)
            {
                double x1 = double.MaxValue, y1 = double.MaxValue, x2 = 0, y2 = 0;
                foreach (OcrWord word in line.Words)
                {
                    Rect r = word.BoundingRect;
                    if (r.X < x1) x1 = r.X;
                    if (r.Y < y1) y1 = r.Y;
                    if (r.X + r.Width > x2) x2 = r.X + r.Width;
                    if (r.Y + r.Height > y2) y2 = r.Y + r.Height;
                }
                if (x2 <= x1 || y2 <= y1) continue;
                lines.Add(new object[] { line.Text, 1.0, new object[] { Math.Round(x1 / scale, 1), Math.Round(y1 / scale, 1), Math.Round(x2 / scale, 1), Math.Round(y2 / scale, 1) } });
            }
        }
        return lines;
    }
}

// ------------------------------------------------------------ UI Automation

static class Uia
{
    class Node { public AutomationElement element; public IntPtr root; public bool chromium; }
    static readonly Dictionary<int, Node> live = new Dictionary<int, Node>();
    static int next = 1;
    const int ActTimeoutMs = 1500; // a pattern call on a Win32 button returns only when the dialog it opened has closed
    const int SetTimeoutMs = 4000; // the clicks into a Chromium field, each guarded on its own, with the waits between (see SetChromium)
    const int ValueChars = 120; // of a field's value, in a tree: the listing shows no more

    static readonly AutomationProperty[] Wanted = {
        AutomationElement.RuntimeIdProperty, AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.BoundingRectangleProperty,
        AutomationElement.HelpTextProperty, AutomationElement.IsEnabledProperty, AutomationElement.IsPasswordProperty,
        AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty, AutomationElement.IsTogglePatternAvailableProperty,
        AutomationElement.IsSelectionItemPatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty, AutomationElement.IsScrollItemPatternAvailableProperty,
        ValuePattern.ValueProperty, ValuePattern.IsReadOnlyProperty, SelectionItemPattern.IsSelectedProperty,
    };

    static CacheRequest Request(AutomationProperty[] properties, Condition filter, bool descendants)
    {
        CacheRequest request = new CacheRequest();
        foreach (AutomationProperty p in properties) request.Add(p);
        request.TreeScope = descendants ? TreeScope.Element | TreeScope.Descendants : TreeScope.Element;
        request.TreeFilter = filter;
        request.AutomationElementMode = AutomationElementMode.Full;
        return request;
    }

    static bool Flag(AutomationElement el, AutomationProperty p) { object v = el.GetCachedPropertyValue(p, true); return v is bool && (bool)v; }
    static string Text(AutomationElement el, AutomationProperty p) { object v = el.GetCachedPropertyValue(p, true); return v is string ? (string)v : ""; }
    static string Clean(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        StringBuilder b = new StringBuilder();
        bool space = false;
        foreach (char c in s) { if (char.IsWhiteSpace(c) || char.IsControl(c)) { space = b.Length > 0; continue; } if (space) b.Append(' '); space = false; b.Append(c); }
        return b.ToString();
    }
    static object[] FrameOf(object box)
    {
        if (!(box is System.Windows.Rect)) return null;
        System.Windows.Rect r = (System.Windows.Rect)box;
        if (r.IsEmpty || double.IsInfinity(r.Width) || double.IsNaN(r.X)) return null;
        return new object[] { Math.Round(r.X), Math.Round(r.Y), Math.Round(r.Width), Math.Round(r.Height) };
    }

    /** UIA control types as the accessibility roles the shared walk knows. */
    static string Role(ControlType type, bool editable, bool inMenuBar)
    {
        if (type == ControlType.Button) return "AXButton";
        if (type == ControlType.Hyperlink) return "AXLink";
        if (type == ControlType.Edit) return "AXTextField";
        if (type == ControlType.Document) return editable ? "AXTextArea" : "AXGroup";
        if (type == ControlType.CheckBox) return "AXCheckBox";
        if (type == ControlType.RadioButton) return "AXRadioButton";
        if (type == ControlType.ComboBox) return "AXComboBox";
        if (type == ControlType.TabItem) return "AXTab";
        if (type == ControlType.ListItem || type == ControlType.DataItem || type == ControlType.TreeItem) return "AXRow";
        if (type == ControlType.MenuItem) return inMenuBar ? "AXMenuBarItem" : "AXMenuButton";
        if (type == ControlType.MenuBar) return "AXMenuBar";
        if (type == ControlType.Menu) return "AXMenu";
        if (type == ControlType.Image) return "AXImage";
        if (type == ControlType.Slider) return "AXSlider";
        if (type == ControlType.Spinner) return "AXIncrementor";
        if (type == ControlType.SplitButton) return "AXMenuButton";
        if (type == ControlType.Text) return "AXStaticText";
        return "AXGroup";
    }

    static string Key(AutomationElement el)
    {
        int[] id = el.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty, true) as int[];
        return id == null ? null : string.Join(".", Array.ConvertAll(id, delegate (int i) { return i.ToString(CultureInfo.InvariantCulture); }));
    }

    public static bool IsChromium(IntPtr hwnd) { return Desk.ClassOf(hwnd).StartsWith("Chrome_WidgetWin", StringComparison.Ordinal); }

    static int Keep(AutomationElement el, IntPtr root, bool chromium)
    {
        int id = next++;
        Node n = new Node(); n.element = el; n.root = root; n.chromium = chromium;
        live[id] = n;
        return id;
    }

    public static void Release() { live.Clear(); }

    /**
     * The controls of a window as a flat list, one cached fetch per root. A covered WinUI window's tree can stop at the
     * title bar while its child windows still answer, and a UWP frame holds its app in a CoreWindow child, so every child
     * window is read as a root too, once. Chrome switches its page tree on when a client first touches the render widget's
     * window, which reading the children does.
     */
    public static object Tree(IntPtr hwnd, int cap, int ms)
    {
        Stopwatch clock = Stopwatch.StartNew();
        bool chromium = IsChromium(hwnd);
        List<object> nodes = new List<object>();
        HashSet<string> visited = new HashSet<string>();
        List<IntPtr> roots = new List<IntPtr>();
        roots.Add(hwnd);
        Win.EnumChildWindows(hwnd, delegate (IntPtr c, IntPtr l) { if (Win.IsWindowVisible(c)) roots.Add(c); return true; }, IntPtr.Zero);
        bool capped = false;
        foreach (IntPtr root in roots)
        {
            if (nodes.Count >= cap || clock.ElapsedMilliseconds > ms) { capped = true; break; }
            try
            {
                AutomationElement top;
                if (root != hwnd)
                {
                    using (Request(new[] { AutomationElement.RuntimeIdProperty }, Automation.ControlViewCondition, false).Activate()) top = AutomationElement.FromHandle(root);
                    string key = Key(top);
                    if (key != null && visited.Contains(key)) continue; // an island the window's own tree already reached
                }
                using (Request(Wanted, Automation.ControlViewCondition, true).Activate()) top = AutomationElement.FromHandle(root);
                Walk(top, -1, false, hwnd, chromium, nodes, visited, cap, clock, ms, ref capped);
            }
            catch (Exception) { /* a child window with no provider, or one that went away */ }
        }
        return new Dictionary<string, object> { { "nodes", nodes }, { "capped", capped }, { "ms", clock.ElapsedMilliseconds } };
    }

    static void Walk(AutomationElement el, int parent, bool inMenuBar, IntPtr root, bool chromium, List<object> nodes, HashSet<string> visited, int cap, Stopwatch clock, int ms, ref bool capped)
    {
        if (nodes.Count >= cap || clock.ElapsedMilliseconds > ms) { capped = true; return; }
        string key = Key(el);
        if (key != null && !visited.Add(key)) return;
        ControlType type = el.GetCachedPropertyValue(AutomationElement.ControlTypeProperty, true) as ControlType;
        bool hasValue = Flag(el, AutomationElement.IsValuePatternAvailableProperty);
        bool editable = hasValue && !Flag(el, ValuePattern.IsReadOnlyProperty);
        string label = Clean(Text(el, AutomationElement.NameProperty));
        if (label.Length == 0) label = Clean(Text(el, AutomationElement.HelpTextProperty));
        if (label.Length == 0 && hasValue && !Flag(el, AutomationElement.IsPasswordProperty)) { string v = Clean(Text(el, ValuePattern.ValueProperty)); if (v.Length <= 120) label = v; }
        List<object> actions = new List<object>();
        bool pressable = type == ControlType.Button || type == ControlType.Hyperlink
            || Flag(el, AutomationElement.IsInvokePatternAvailableProperty) || Flag(el, AutomationElement.IsTogglePatternAvailableProperty)
            || Flag(el, AutomationElement.IsSelectionItemPatternAvailableProperty) || Flag(el, AutomationElement.IsExpandCollapsePatternAvailableProperty);
        if (pressable) actions.Add("AXPress");
        if (Flag(el, AutomationElement.IsScrollItemPatternAvailableProperty)) actions.Add("AXScrollToVisible");
        int id = Keep(el, root, chromium);
        Dictionary<string, object> node = new Dictionary<string, object> {
            { "id", id }, { "parent", parent }, { "role", Role(type, editable, inMenuBar) }, { "label", label },
            { "frame", FrameOf(el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty, true)) }, { "actions", actions },
        };
        // What a field holds, which the listing shows after its label: a field that reads empty is typed into again,
        // and appends. Only a field's (a link's value is its URL, which says nothing), never a password's, and not when
        // the value is already the label, for a field that has no name of its own.
        if (editable && (type == ControlType.Edit || type == ControlType.Document || type == ControlType.ComboBox) && !Flag(el, AutomationElement.IsPasswordProperty))
        {
            string value = Clean(Text(el, ValuePattern.ValueProperty));
            if (value.Length > ValueChars) value = value.Substring(0, ValueChars) + "…";
            if (value != label) node["value"] = value;
        }
        nodes.Add(node);
        foreach (AutomationElement child in el.CachedChildren) Walk(child, id, type == ControlType.MenuBar, root, chromium, nodes, visited, cap, clock, ms, ref capped);
    }

    /** The element with the keyboard focus, wherever it is: role, label, placeholder (its help text), value and frame. */
    public static object Focused()
    {
        AutomationElement el;
        using (Request(Wanted, Automation.ControlViewCondition, false).Activate()) el = AutomationElement.FocusedElement;
        if (el == null) return null;
        object handle = el.GetCurrentPropertyValue(AutomationElement.NativeWindowHandleProperty, true);
        IntPtr hwnd = handle is int ? new IntPtr((int)handle) : IntPtr.Zero;
        IntPtr root = hwnd != IntPtr.Zero ? Win.GetAncestor(hwnd, 2) : IntPtr.Zero;
        ControlType type = el.GetCachedPropertyValue(AutomationElement.ControlTypeProperty, true) as ControlType;
        bool hasValue = Flag(el, AutomationElement.IsValuePatternAvailableProperty);
        object[] frame = FrameOf(el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty, true));
        return new Dictionary<string, object> {
            { "id", Keep(el, root, root != IntPtr.Zero && IsChromium(root)) }, { "role", Role(type, hasValue && !Flag(el, ValuePattern.IsReadOnlyProperty), false) },
            { "label", Clean(Text(el, AutomationElement.NameProperty)) }, { "placeholder", Clean(Text(el, AutomationElement.HelpTextProperty)) },
            { "value", hasValue && !Flag(el, AutomationElement.IsPasswordProperty) ? Text(el, ValuePattern.ValueProperty) : "" }, { "frame", frame },
        };
    }

    static Node Of(int id) { Node n; if (!live.TryGetValue(id, out n)) throw new Exception("no such element; read the window again"); return n; }

    static System.Windows.Rect CurrentRect(AutomationElement el) { object r = el.GetCurrentPropertyValue(AutomationElement.BoundingRectangleProperty, true); return r is System.Windows.Rect ? (System.Windows.Rect)r : System.Windows.Rect.Empty; }

    /**
     * Whether a Chromium element has the keyboard focus inside its own window: the element says so, or the window's
     * thread has its focus in this window's page. Not the system's focus, which from behind lies in the user's window.
     */
    static bool FocusedIn(Node n)
    {
        try { object has = n.element.GetCurrentPropertyValue(AutomationElement.HasKeyboardFocusProperty, true); if (has is bool && (bool)has) return true; }
        catch (Exception) { }
        Win.GUITHREADINFO info = new Win.GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(Win.GUITHREADINFO));
        uint pid;
        uint thread = Win.GetWindowThreadProcessId(n.root, out pid);
        return Win.GetGUIThreadInfo(thread, ref info) && info.hwndFocus != IntPtr.Zero && Win.IsChild(n.root, info.hwndFocus) && Desk.ClassOf(info.hwndFocus) == "Chrome_RenderWidgetHostHWND";
    }

    /** A posted click at an element's center: how a Chromium control is pressed without Chrome taking the seat, which every UIA action makes it do. */
    static bool ClickOn(Node n, int count)
    {
        System.Windows.Rect r = CurrentRect(n.element);
        if (r.IsEmpty) return false;
        int x = (int)(r.X + r.Width / 2), y = (int)(r.Y + r.Height / 2);
        Input.Post(n.root, "move", x, y);
        for (int i = 0; i < count; i++) { Input.Post(n.root, "down", x, y); Input.Post(n.root, "up", x, y); }
        return true;
    }

    /** Where a Chromium window shows its page, on screen: its largest render widget, or the whole window when it has none. */
    static Win.RECT PageOf(IntPtr root)
    {
        Win.RECT best = Desk.Frame(root);
        long area = 0;
        Win.EnumChildWindows(root, delegate (IntPtr c, IntPtr l)
        {
            if (!Win.IsWindowVisible(c) || Desk.ClassOf(c) != "Chrome_RenderWidgetHostHWND") return true;
            Win.RECT r;
            Win.GetWindowRect(c, out r);
            long a = (long)(r.R - r.L) * (r.B - r.T);
            if (a > area) { area = a; best = r; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    static bool InPage(IntPtr root, System.Windows.Rect r)
    {
        if (r.IsEmpty) return false;
        Win.RECT page = PageOf(root);
        double x = r.X + r.Width / 2, y = r.Y + r.Height / 2;
        return x >= page.L && x < page.R && y >= page.T && y < page.B;
    }

    /**
     * A Chromium control is pressed by a posted click at its center. One scrolled out of the page's view is brought into
     * it first (the scroll-item pattern, which works from behind), since a click outside the page lands on the toolbar or
     * on nothing: "not visible" when it will not come.
     */
    static string PressChromium(Node n, bool sink, List<object> popups)
    {
        System.Windows.Rect r = CurrentRect(n.element);
        if (r.IsEmpty) return "no rect";
        if (!InPage(n.root, r))
        {
            Timed(delegate
            {
                object p;
                if (n.element.TryGetCurrentPattern(ScrollItemPattern.Pattern, out p)) ((ScrollItemPattern)p).ScrollIntoView();
                return "ok";
            });
            Thread.Sleep(150);
            if (!InPage(n.root, CurrentRect(n.element))) return "not visible: it would not scroll into the page's view";
        }
        Flash.Moment moment = Flash.Begin(n.root, sink); // only the click brings the window forward: the scroll above does not
        try { return ClickOn(n, 1) ? "ok" : "no rect"; }
        finally { popups.AddRange((List<object>)Flash.End(moment)["popups"]); } // a window the click opened (a page's pop-up, a sign-in)
    }

    delegate string Work();

    /** A pattern call cut off after ActTimeoutMs, taken as done: it opened something modal and is waiting for it, and the next look will show what. */
    static string Timed(Work work)
    {
        Thread thread;
        return Within(work, ActTimeoutMs, out thread) ?? "ok";
    }

    /** `work` on a thread of its own, given `ms`: its result, or null when it is still going (and `thread` is it). */
    static string Within(Work work, int ms, out Thread thread)
    {
        string result = null;
        Exception failure = null;
        thread = new Thread(delegate () { try { result = work(); } catch (Exception e) { failure = e; } });
        thread.IsBackground = true;
        thread.Start();
        if (!thread.Join(ms)) return null;
        if (failure != null) throw failure;
        return result;
    }

    /**
     * An action on an element. `sink`: the element's window is the hand's own, to go back behind the user's after a click
     * brings it forward (see Flash). {ok, why, popups}: the windows a press in a page opened.
     */
    public static object Act(int id, string action, bool sink)
    {
        Node n = Of(id);
        string result;
        List<object> popups = new List<object>();
        if (action == "AXPress")
        {
            if (n.chromium) result = PressChromium(n, sink, popups);
            else result = Timed(delegate
            {
                object p;
                if (n.element.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return "ok"; }
                if (n.element.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return "ok"; }
                if (n.element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return "ok"; }
                if (n.element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p))
                {
                    ExpandCollapsePattern ec = (ExpandCollapsePattern)p;
                    if (ec.Current.ExpandCollapseState == ExpandCollapseState.Expanded) ec.Collapse(); else ec.Expand();
                    return "ok";
                }
                return ClickOn(n, 1) ? "ok" : "the element offers no action";
            });
        }
        else if (action == "AXConfirm") { Input.VKey(n.root, 0x0D, false); result = "ok"; }
        else if (action == "AXScrollToVisible")
        {
            object p;
            if (n.element.TryGetCurrentPattern(ScrollItemPattern.Pattern, out p)) { ((ScrollItemPattern)p).ScrollIntoView(); result = "ok"; }
            else result = "the element cannot scroll into view";
        }
        else result = "unknown action " + action;
        return new Dictionary<string, object> { { "ok", result == "ok" }, { "why", result }, { "popups", popups } };
    }

    /** Said, word for word, when text with a line break is refused: the tools know it by its start. */
    public const string LineBreak = "line break: a line break typed here would press Enter, which sends the message in a chat app. Type it as one line, or press shift+enter for the break with the real keyboard";

    static Thread focusing; // the clicks into the last Chromium field, when they outlived their time: nothing is typed until they are done

    /**
     * A field's text. A classic edit control takes it as messages (select all, replace), which is what typing does and
     * takes no focus, and a line break in it is text, not a key. Chromium takes focus on a posted click and then the
     * characters posted (see SetChromium). Anything else takes ValuePattern, which on some apps focuses the control but
     * not the window.
     */
    public static object SetValue(int id, string text, bool sink)
    {
        Node n = Of(id);
        if (n.chromium) return SetChromium(n, text, sink);
        string result = Timed(delegate
        {
            object handle = n.element.GetCurrentPropertyValue(AutomationElement.NativeWindowHandleProperty, true);
            IntPtr window = handle is int && (int)handle != 0 ? new IntPtr((int)handle) : IntPtr.Zero;
            string kind = window != IntPtr.Zero ? Desk.ClassOf(window) : "";
            if (kind == "Edit" || kind.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase))
            {
                Win.SendMessage(window, 0x00B1, IntPtr.Zero, new IntPtr(-1)); // EM_SETSEL
                Win.SendMessageText(window, 0x00C2, new IntPtr(1), text.Replace("\r\n", "\n").Replace("\n", "\r\n")); // EM_REPLACESEL
                return "ok";
            }
            object p;
            if (!n.element.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return "the element takes no value";
            ((ValuePattern)p).SetValue(text);
            return "ok";
        });
        return new Dictionary<string, object> { { "ok", result == "ok" }, { "why", result }, { "posted", false } };
    }

    /**
     * Text into a Chromium field from behind. Clicked once, and again half a second on when the click did not give it the
     * focus (WhatsApp's search box swallows the first): separate clicks, not a double or triple click, which an editor
     * built on a framework (WhatsApp's composer, on Lexical) answers by dropping what is then typed (measured). Text it
     * holds is selected with a triple click first, for the new text to replace it, as an ordinary field expects. The
     * clicks get their own time (see FocusChromium); the characters are posted after, all of them, before the reply, so
     * the text is in when this returns and nothing is still typing behind a refusal. A line break would be Enter, which
     * sends in a chat app, and a tab in a browser can walk into its toolbar: text with either is refused.
     */
    static object SetChromium(Node n, string text, bool sink)
    {
        if (text.IndexOf('\n') >= 0 || text.IndexOf('\r') >= 0) throw new Exception(LineBreak);
        if (text.IndexOf('\t') >= 0 && Input.IsBrowser(n.root)) throw new Exception(Input.TabKey);
        if (focusing != null && focusing.IsAlive) return new Dictionary<string, object> { { "ok", false }, { "why", "the last field is still being clicked into: look again first" }, { "posted", false } };
        Thread clicks;
        Cancel cancel = new Cancel();
        string focused = Within(delegate { return FocusChromium(n, sink, cancel); }, SetTimeoutMs, out clicks);
        if (focused == null)
        {
            cancel.Set(); // no click is posted from here on: one under way still has its foreground handed back
            focusing = clicks;
            return new Dictionary<string, object> { { "ok", false }, { "why", "the field did not answer the click in time" }, { "posted", false } };
        }
        if (focused != "ok") return new Dictionary<string, object> { { "ok", false }, { "why", focused }, { "posted", false } };
        Input.Chars(n.root, text, false);
        return new Dictionary<string, object> { { "ok", true }, { "why", "ok" }, { "posted", true } }; // posted: as keystrokes, which the tree shows a beat later
    }

    /** Set once a piece of work on a thread of its own has been given up on: it does nothing more that the user could see. */
    class Cancel
    {
        volatile bool set;
        public bool IsSet { get { return set; } }
        public void Set() { set = true; }
    }

    delegate void Step();

    /**
     * The clicks that put a Chromium field's caret in it, each guarded on its own (see Flash): the window is in front
     * only from a click to its handback, about 70 ms, and the half-second waits between happen with the foreground back
     * with the user. Whether the field took the focus is asked before that handback, since a thread that is not in front
     * says it has none. A click that would follow once the user has gone back to the mouse or keyboard is not made
     * (Flash.Busy); nor any once the work has been given up on. After the last click, the window is watched a while
     * more, for Chrome taking the foreground a second time.
     */
    static string FocusChromium(Node n, bool sink, Cancel cancel)
    {
        Flash.Moment last = null;
        bool took = false;
        string clicked = GuardedClick(n, 1, sink, cancel, ref last, delegate { Thread.Sleep(80); took = FocusedIn(n); });
        if (clicked == "ok" && !took)
        {
            Thread.Sleep(500);
            clicked = GuardedClick(n, 1, sink, cancel, ref last, delegate { Thread.Sleep(80); });
        }
        if (clicked == "ok")
        {
            object had;
            string held = n.element.TryGetCurrentPattern(ValuePattern.Pattern, out had) ? ((ValuePattern)had).Current.Value : null;
            if (!string.IsNullOrWhiteSpace(held))
            {
                Thread.Sleep(500);
                clicked = GuardedClick(n, 3, sink, cancel, ref last, delegate { Thread.Sleep(60); });
            }
        }
        if (last != null) Flash.Linger(last);
        return clicked;
    }

    /** `count` clicks at an element's center, guarded on their own; `then` runs while the window may still be in front. */
    static string GuardedClick(Node n, int count, bool sink, Cancel cancel, ref Flash.Moment last, Step then)
    {
        if (cancel.IsSet) return "the field did not answer the click in time";
        if (!Seat.Paused(Flash.QuietMs)) return Flash.Busy;
        Flash.Moment moment = Flash.Begin(n.root, sink);
        last = moment;
        try
        {
            if (!ClickOn(n, count)) return "no rect";
            then();
            return "ok";
        }
        finally { Flash.Return(moment); }
    }

    public static object Value(int id)
    {
        Node n = Of(id);
        object p;
        string value = null;
        if (n.element.TryGetCurrentPattern(ValuePattern.Pattern, out p)) value = ((ValuePattern)p).Current.Value;
        else
        {
            ControlType type = n.element.Current.ControlType;
            if (type == ControlType.Edit || type == ControlType.Document || type == ControlType.Text) value = n.element.Current.Name;
        }
        return new Dictionary<string, object> { { "value", value } };
    }

    // ------------------------------------------------------------ the browser's own controls

    static readonly AutomationProperty[] BrowserWanted = { AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.BoundingRectangleProperty, SelectionItemPattern.IsSelectedProperty, ValuePattern.ValueProperty, AutomationElement.IsValuePatternAvailableProperty };

    /**
     * What a Chromium window shows of itself: its tabs (title, selected, frame, close button), the active page's URL
     * from the Document's value, the omnibox, the toolbar buttons, and whether it is loading (the reload button reads Stop).
     */
    public static object Browser(IntPtr hwnd)
    {
        Condition filter = new OrCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem), new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit), new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
        AutomationElement top;
        using (Request(BrowserWanted, filter, true).Activate()) top = AutomationElement.FromHandle(hwnd);
        List<object> tabs = new List<object>();
        Dictionary<string, object> buttons = new Dictionary<string, object>();
        string url = null;
        object[] omnibox = null;
        string omniboxValue = "";
        bool loading = false;
        List<AutomationElement> queue = new List<AutomationElement>();
        queue.Add(top);
        for (int i = 0; i < queue.Count; i++)
        {
            AutomationElement el = queue[i];
            ControlType type = el.GetCachedPropertyValue(AutomationElement.ControlTypeProperty, true) as ControlType;
            string name = Clean(Text(el, AutomationElement.NameProperty));
            object[] frame = FrameOf(el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty, true));
            if (type == ControlType.TabItem)
            {
                object[] close = null;
                foreach (AutomationElement kid in el.CachedChildren)
                {
                    if (Clean(Text(kid, AutomationElement.NameProperty)).StartsWith("Close", StringComparison.Ordinal)) close = FrameOf(kid.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty, true));
                }
                int cut = name.IndexOf(" - Memory usage - ", StringComparison.Ordinal);
                tabs.Add(new Dictionary<string, object> { { "title", cut > 0 ? name.Substring(0, cut) : name }, { "active", Flag(el, SelectionItemPattern.IsSelectedProperty) }, { "frame", frame }, { "close", close } });
                continue; // the close button was taken above
            }
            if (type == ControlType.Button && frame != null)
            {
                if (name.StartsWith("Stop", StringComparison.Ordinal)) loading = true;
                if (!buttons.ContainsKey(name)) buttons[name] = frame;
            }
            else if (type == ControlType.Edit && name == "Address and search bar") { omnibox = frame; omniboxValue = Text(el, ValuePattern.ValueProperty); }
            else if (type == ControlType.Document)
            {
                if (url == null && Flag(el, AutomationElement.IsValuePatternAvailableProperty)) { string v = Text(el, ValuePattern.ValueProperty); if (v.Length > 0) url = v; }
                continue; // the page's own tabs and buttons are not the browser's
            }
            foreach (AutomationElement kid in el.CachedChildren) queue.Add(kid);
        }
        // A window whose page tree is not on yet has no Document with a value; touching the render widget's window switches it on.
        if (url == null)
        {
            List<IntPtr> children = new List<IntPtr>();
            Win.EnumChildWindows(hwnd, delegate (IntPtr c, IntPtr l) { if (Desk.ClassOf(c) == "Chrome_RenderWidgetHostHWND") children.Add(c); return true; }, IntPtr.Zero);
            foreach (IntPtr child in children)
            {
                try
                {
                    AutomationElement island;
                    using (Request(BrowserWanted, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document), true).Activate()) island = AutomationElement.FromHandle(child);
                    List<AutomationElement> docs = new List<AutomationElement>();
                    docs.Add(island);
                    for (int i = 0; i < docs.Count && url == null; i++)
                    {
                        string v = Flag(docs[i], AutomationElement.IsValuePatternAvailableProperty) ? Text(docs[i], ValuePattern.ValueProperty) : "";
                        if (v.Length > 0) url = v;
                        foreach (AutomationElement kid in docs[i].CachedChildren) docs.Add(kid);
                    }
                }
                catch (Exception) { }
                if (url != null) break;
            }
        }
        return new Dictionary<string, object> { { "tabs", tabs }, { "url", url }, { "omnibox", omnibox }, { "omniboxValue", omniboxValue }, { "buttons", buttons }, { "loading", loading } };
    }

    // ------------------------------------------------------------ menus and scrolling

    static string Plain(string title) { title = Clean(title); if (title.EndsWith("...")) title = title.Substring(0, title.Length - 3); if (title.EndsWith("…")) title = title.Substring(0, title.Length - 1); return title.Trim().ToLowerInvariant(); }
    static string Name(AutomationElement el) { try { return Clean(el.Current.Name); } catch (Exception) { return ""; } }
    static List<AutomationElement> MenuItems(AutomationElement menu)
    {
        List<AutomationElement> items = new List<AutomationElement>();
        foreach (AutomationElement kid in menu.FindAll(TreeScope.Children, Condition.TrueCondition))
        {
            ControlType t = kid.Current.ControlType;
            if (t == ControlType.MenuItem) items.Add(kid);
            else if (t == ControlType.Menu || t == ControlType.Group || t == ControlType.Pane || t == ControlType.List) items.AddRange(MenuItems(kid));
        }
        return items;
    }
    static List<string> Names(List<AutomationElement> items) { List<string> names = new List<string>(); foreach (AutomationElement item in items) { string n = Name(item); if (n.Length > 0) names.Add(n + (item.Current.IsEnabled ? "" : " (unavailable)")); } return names; }
    static HashSet<long> TopWindows()
    {
        HashSet<long> all = new HashSet<long>();
        for (IntPtr h = Win.GetTopWindow(IntPtr.Zero); h != IntPtr.Zero; h = Win.GetWindow(h, 2)) if (Win.IsWindowVisible(h)) all.Add(h.ToInt64());
        return all;
    }

    /** The items of what a press opened: a popup window of its own that was not there before (Win32 and WinUI flyouts alike), else a submenu inside the item. */
    static List<AutomationElement> OpenedItems(AutomationElement item, HashSet<long> before)
    {
        List<AutomationElement> items = new List<AutomationElement>();
        foreach (long h in TopWindows())
        {
            if (before.Contains(h)) continue;
            try { foreach (AutomationElement el in AutomationElement.FromHandle(new IntPtr(h)).FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem))) items.Add(el); }
            catch (Exception) { }
        }
        if (items.Count == 0) foreach (AutomationElement el in item.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem))) items.Add(el);
        return items;
    }

    /** The window's own menu bar: not the title bar's System menu, which UIA lists first and which holds only Restore, Move and Close. */
    static AutomationElement MenuBarOf(AutomationElement window)
    {
        foreach (AutomationElement bar in window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuBar)))
        {
            string id = "";
            try { id = bar.Current.AutomationId; } catch (Exception) { }
            string name = Name(bar);
            if (id == "SystemMenuBar" || name == "System Menu Bar" || name == "System") continue;
            return bar;
        }
        return null;
    }

    /**
     * A menu command by its path off the menu bar. Opening a menu shows it on screen: on Windows an item is pressed only
     * where it is open. Each press gets the pattern calls' time, since an item that opens a modal dialog does not return
     * until the dialog closes; and whatever this opened that is still open at the end (a path that lists a menu, one that
     * went wrong) is closed again, deepest first, since an open menu holds the app's keyboard.
     */
    public static object Menu(IntPtr hwnd, object[] path)
    {
        AutomationElement window = AutomationElement.FromHandle(hwnd);
        AutomationElement bar = MenuBarOf(window);
        if (bar == null) throw new Exception("this app has no menu bar: its commands are the buttons in its window (a ribbon, a toolbar), pressed by their index in `screen`");
        List<AutomationElement> items = MenuItems(bar);
        List<AutomationElement> expanded = new List<AutomationElement>();
        AutomationElement at = null;
        try
        {
            for (int depth = 0; depth < path.Length; depth++)
            {
                string name = Convert.ToString(path[depth]);
                AutomationElement found = null;
                foreach (AutomationElement item in items) if (Plain(Name(item)) == Plain(name)) { found = item; break; }
                if (found == null) throw new Exception("no " + json.Serialize(name) + " in " + (depth == 0 ? "the menu bar" : JoinPath(path, depth)) + "; it has: " + string.Join(", ", Names(items).ToArray()));
                if (!found.Current.IsEnabled) throw new Exception(JoinPath(path, depth + 1) + " is unavailable right now. An app dims commands that have nothing to act on: put its cursor or selection where the command applies first.");
                HashSet<long> before = TopWindows();
                AutomationElement pressing = found;
                Thread thread;
                string how = Within(delegate { return Press(pressing); }, ActTimeoutMs, out thread);
                if (how == null) return new Dictionary<string, object> { { "pressed", JoinPath(path, depth + 1) + " (it opened a window that is waiting for an answer)" } };
                if (how == "expanded") expanded.Add(found);
                at = found;
                Thread.Sleep(400);
                items = OpenedItems(found, before);
                if (items.Count == 0 && depth < path.Length - 1) throw new Exception(JoinPath(path, depth + 1) + " opened no menu");
            }
            if (at == null || items.Count > 0) return new Dictionary<string, object> { { "items", Names(items) } };
            return new Dictionary<string, object> { { "pressed", JoinPath(path, path.Length) } };
        }
        finally
        {
            for (int i = expanded.Count - 1; i >= 0; i--)
            {
                AutomationElement item = expanded[i];
                Thread thread;
                try
                {
                    Within(delegate
                    {
                        object p;
                        if (item.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p) && ((ExpandCollapsePattern)p).Current.ExpandCollapseState != ExpandCollapseState.Collapsed) ((ExpandCollapsePattern)p).Collapse();
                        return "ok";
                    }, 500, out thread);
                }
                catch (Exception) { }
            }
        }
    }
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static string JoinPath(object[] path, int count) { List<string> parts = new List<string>(); for (int i = 0; i < count; i++) parts.Add(Convert.ToString(path[i])); return string.Join(" > ", parts.ToArray()); }
    static string Press(AutomationElement item)
    {
        object p;
        if (item.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { ((ExpandCollapsePattern)p).Expand(); return "expanded"; }
        if (item.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return "invoked"; }
        throw new Exception(Name(item) + " did not accept the press");
    }

    /** Page the largest scrollable area of a window. On Chromium the scroll pattern takes the seat, so a wheel is posted instead. */
    public static object ScrollPage(IntPtr hwnd, string direction)
    {
        bool ok = false;
        if (!IsChromium(hwnd))
        {
            AutomationElement window = AutomationElement.FromHandle(hwnd);
            AutomationElement best = null;
            double bestArea = 0;
            foreach (AutomationElement el in window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.IsScrollPatternAvailableProperty, true)))
            {
                System.Windows.Rect r = CurrentRect(el);
                if (!r.IsEmpty && r.Width * r.Height > bestArea) { bestArea = r.Width * r.Height; best = el; }
            }
            if (best != null)
            {
                ScrollPattern s = (ScrollPattern)best.GetCurrentPattern(ScrollPattern.Pattern);
                bool vertical = direction == "up" || direction == "down";
                ScrollAmount amount = direction == "up" || direction == "left" ? ScrollAmount.LargeDecrement : ScrollAmount.LargeIncrement;
                if (vertical ? s.Current.VerticallyScrollable : s.Current.HorizontallyScrollable)
                {
                    s.Scroll(vertical ? ScrollAmount.NoAmount : amount, vertical ? amount : ScrollAmount.NoAmount);
                    ok = true;
                }
            }
        }
        if (!ok)
        {
            Win.RECT r = Desk.Frame(hwnd);
            int sign = direction == "up" || direction == "left" ? 1 : -1;
            Input.Wheel(hwnd, (r.L + r.R) / 2, (r.T + r.B) / 2, sign * 120 * 5, direction == "left" || direction == "right");
            ok = true;
        }
        return new Dictionary<string, object> { { "ok", ok } };
    }
}

// ------------------------------------------------------------ input

static class Input
{
    /**
     * The window a message for a point goes to: the deepest visible, enabled child under it. Chrome's page takes its input
     * on the top-level window or the render widget's; its D3D surface takes nothing, so those stop at the top.
     */
    static IntPtr TargetAt(IntPtr top, int sx, int sy)
    {
        IntPtr cur = top;
        for (int depth = 0; depth < 12; depth++)
        {
            Win.POINT p = new Win.POINT(); p.x = sx; p.y = sy;
            Win.ScreenToClient(cur, ref p);
            IntPtr next = Win.ChildWindowFromPointEx(cur, p, 0x0001 | 0x0002);
            if (next == IntPtr.Zero || next == cur) break;
            string cls = Desk.ClassOf(next);
            if (cls == "Intermediate D3D Window" || (cls.StartsWith("Chrome_", StringComparison.Ordinal) && cls != "Chrome_RenderWidgetHostHWND")) break;
            cur = next;
        }
        return cur;
    }

    /**
     * Where keys go: the window the app's own thread says has the focus, when that is inside this window. A thread that
     * is not in front has no focus to say (measured), and the window itself drops keys, so then the deepest visible text
     * control in it: Notepad's editor (each tab has its own, and only the tab showing is visible), a dialog's first Edit,
     * Excel's grid (all measured to take posted keys). Else a UWP app's CoreWindow, or the window itself: Chrome takes
     * keys at its top-level window.
     */
    static IntPtr KeyTarget(IntPtr top)
    {
        Win.GUITHREADINFO info = new Win.GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(Win.GUITHREADINFO));
        uint pid; uint thread = Win.GetWindowThreadProcessId(top, out pid);
        if (Win.GetGUIThreadInfo(thread, ref info) && info.hwndFocus != IntPtr.Zero && (info.hwndFocus == top || Win.IsChild(top, info.hwndFocus))) return info.hwndFocus;
        IntPtr text = IntPtr.Zero;
        int deepest = -1;
        Win.EnumChildWindows(top, delegate (IntPtr c, IntPtr l)
        {
            if (!Win.IsWindowVisible(c) || !Editable(Desk.ClassOf(c))) return true;
            int depth = 0;
            for (IntPtr p = Win.GetParent(c); p != IntPtr.Zero && p != top && depth < 32; p = Win.GetParent(p)) depth++;
            if (depth > deepest) { deepest = depth; text = c; }
            return true;
        }, IntPtr.Zero);
        if (text != IntPtr.Zero) return text;
        IntPtr core = Desk.CoreOf(top);
        return core != IntPtr.Zero ? core : top;
    }

    static bool Editable(string cls)
    {
        return cls == "Edit" || cls == "EXCEL7" || cls.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase);
    }

    /**
     * A Chromium window drops posted keys while it is not active, and takes them once told it is, with a posted
     * WM_ACTIVATE: nothing moves and the window stays where it is (measured: characters into inputs and editable text,
     * Enter, Escape, arrows, Tab). Nothing for any other window.
     */
    static void Awaken(IntPtr top)
    {
        if (Uia.IsChromium(top)) { Win.PostMessage(top, 0x0006, new IntPtr(1), IntPtr.Zero); Thread.Sleep(30); } // WM_ACTIVATE, WA_ACTIVE
    }

    /** Input the system counts as input, and which moves nothing: the cursor sent to where it is. What lets the helper bring a window forward after a long idle. */
    public static void Nudge()
    {
        Win.POINT p;
        Win.GetCursorPos(out p);
        List<INPUT> inputs = new List<INPUT>();
        inputs.Add(MoveTo(p.x, p.y));
        SendAll(inputs);
    }

    static IntPtr Packed(int x, int y) { return new IntPtr((y << 16) | (x & 0xFFFF)); }

    public static object Post(IntPtr top, string kind, int sx, int sy)
    {
        IntPtr target = TargetAt(top, sx, sy);
        Win.POINT p = new Win.POINT(); p.x = sx; p.y = sy;
        Win.ScreenToClient(target, ref p);
        IntPtr l = Packed(p.x, p.y);
        bool ok;
        switch (kind)
        {
            case "down": ok = Win.PostMessage(target, 0x0201, new IntPtr(1), l); break;
            case "up": ok = Win.PostMessage(target, 0x0202, IntPtr.Zero, l); break;
            case "drag": ok = Win.PostMessage(target, 0x0200, new IntPtr(1), l); break;
            case "rightdown": ok = Win.PostMessage(target, 0x0204, new IntPtr(2), l); break;
            case "rightup": ok = Win.PostMessage(target, 0x0205, IntPtr.Zero, l); break;
            default: ok = Win.PostMessage(target, 0x0200, IntPtr.Zero, l); break;
        }
        return new Dictionary<string, object> { { "ok", ok }, { "target", target.ToInt64() } };
    }

    /** Said, word for word, when a tab is refused in a browser window: the tools know it by its start. */
    public const string TabKey = "tab: in a page, Tab can walk out of the page into the browser's own toolbar, where the next key presses the browser's buttons (a posted Enter there once bookmarked the page in the user's profile, measured). Click the field you want instead";

    static readonly string[] Browsers = { "chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe", "opera.exe", "arc.exe", "chromium.exe" };

    /** Whether a window is a browser's: Chromium's, of a browser's process (an Electron app's page has no toolbar to walk into). */
    public static bool IsBrowser(IntPtr top)
    {
        if (!Uia.IsChromium(top)) return false;
        string exe = Path.GetFileName(Desk.ImageOf(Desk.PidOf(top))).ToLowerInvariant();
        return Array.IndexOf(Browsers, exe) >= 0;
    }

    /**
     * Text as WM_CHAR, one message a character: a key down as well would type twice in Chrome. A tab goes as the key.
     * `direct` posts to the window itself rather than to its thread's focus (Chrome's omnibox, after a click on it).
     * A line break is where typing from behind goes wrong, since Enter sends the message in a chat app's box: a window
     * that shows a page refuses one (see Web); a classic or rich edit control takes the whole text at its caret as a
     * replacement of its selection, the break as text, which presses nothing; anything else gets Enter for it. A tab
     * in a browser's page is refused too (see TabKey).
     */
    public static object Chars(IntPtr top, string text, bool direct)
    {
        IntPtr target = direct ? top : KeyTarget(top);
        if (!direct && text.IndexOf('\t') >= 0 && IsBrowser(top)) throw new Exception(TabKey);
        if (text.IndexOf('\n') >= 0)
        {
            string cls = Desk.ClassOf(target);
            if (cls.StartsWith("Chrome_", StringComparison.Ordinal) || Web.Hosts(top)) throw new Exception(Uia.LineBreak);
            if (cls == "Edit" || cls.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase))
            {
                IntPtr done;
                if (Win.SendMessageTimeoutText(target, 0x00C2, new IntPtr(1), text.Replace("\r\n", "\n").Replace("\n", "\r\n"), 0x0002, 3000, out done) == IntPtr.Zero) // EM_REPLACESEL, SMTO_ABORTIFHUNG
                    throw new Exception("the text field did not answer");
                return new Dictionary<string, object> { { "ok", true }, { "target", target.ToInt64() } };
            }
        }
        Awaken(top);
        foreach (char c in text)
        {
            if (c == '\n') Key(target, 0x0D);
            else if (c == '\t') Key(target, 0x09);
            else if (c != '\r') Win.PostMessage(target, 0x0102, new IntPtr(c), new IntPtr(1));
            Thread.Sleep(12);
        }
        return new Dictionary<string, object> { { "ok", true }, { "target", target.ToInt64() } };
    }

    /** A key down and up, posted, with its scan code and, for an arrow or the like, the extended-key bit, which Excel's grid needs (measured). */
    static void Key(IntPtr target, int vk)
    {
        uint scan = Win.MapVirtualKey((uint)vk, 0);
        uint extended = Extended((ushort)vk) << 24;
        Win.PostMessage(target, 0x0100, new IntPtr(vk), new IntPtr((long)(1 | (scan << 16) | extended)));
        Win.PostMessage(target, 0x0101, new IntPtr(vk), new IntPtr((long)(1 | (scan << 16) | extended | (0xC0u << 24))));
    }

    public static object VKey(IntPtr top, int vk, bool direct)
    {
        if (!direct && vk == 0x09 && IsBrowser(top)) throw new Exception(TabKey);
        IntPtr target = direct ? top : KeyTarget(top);
        Awaken(top);
        Key(target, vk);
        return new Dictionary<string, object> { { "ok", true }, { "target", target.ToInt64() } };
    }

    public static object Wheel(IntPtr top, int sx, int sy, int delta, bool horizontal)
    {
        IntPtr target = TargetAt(top, sx, sy);
        bool ok = Win.PostMessage(target, horizontal ? 0x020Eu : 0x020Au, new IntPtr((long)(delta << 16)), Packed(sx, sy)); // wheel messages carry screen coordinates
        return new Dictionary<string, object> { { "ok", ok } };
    }

    // ------------------------------------------------------------ the seat: SendInput

    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);

    static void SendAll(List<INPUT> inputs)
    {
        if (inputs.Count == 0) return;
        uint sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        Seat.Injected();
        if (sent != inputs.Count) throw new Exception("SendInput sent " + sent + " of " + inputs.Count + " (error " + Marshal.GetLastWin32Error() + ")");
    }

    /** Let go of the mouse buttons this helper's input holds down (a drag cut short), whatever the user is doing. */
    public static void LetGo()
    {
        List<INPUT> ups = new List<INPUT>();
        foreach (int button in Seat.Pressed()) ups.Add(Mouse(button == 0x02 ? 0x0010u : 0x0004u, 0, 0, 0));
        Seat.Released();
        SendAll(ups);
    }
    static INPUT Mouse(uint flags, int dx, int dy, uint data)
    {
        INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; return i;
    }
    static INPUT KeyInput(ushort vk, ushort scan, uint flags)
    {
        INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i;
    }
    /** Absolute mouse coordinates are 0..65535 over the virtual screen. */
    static INPUT MoveTo(int x, int y)
    {
        int vx = Win.GetSystemMetrics(76), vy = Win.GetSystemMetrics(77), vw = Win.GetSystemMetrics(78), vh = Win.GetSystemMetrics(79);
        int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1)), ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
        return Mouse(0x0001 | 0x8000 | 0x4000, nx, ny, 0); // MOVE | ABSOLUTE | VIRTUALDESK
    }

    /**
     * During a borrow of `root`, why its input must not go on: the window in front is no longer the borrowed one, nor a
     * window of its own (a dialog it opened, a menu of its app). Another hand's handback, or an app that brought itself
     * forward, would otherwise take the keys meant for the borrowed window. Null when it may, and outside a borrow.
     */
    static string Moved(IntPtr root)
    {
        if (root == IntPtr.Zero) return null;
        IntPtr fg = Win.GetForegroundWindow();
        if (fg == IntPtr.Zero || Belongs(fg, root)) return null; // nothing in front for a moment, as the foreground changes hands
        return "the window in front changed to " + Name(Flash.Root(fg));
    }

    /**
     * During a borrow of `root`, why a click or a wheel at x,y must not be sent: something else lies over the borrowed
     * window there (a window that stays on top, the panel or a hand's overlay while it takes the mouse), which the
     * click would land on instead. Null when it may, and outside a borrow.
     */
    static string Covered(IntPtr root, int x, int y)
    {
        if (root == IntPtr.Zero) return null;
        Win.POINT p = new Win.POINT(); p.x = x; p.y = y;
        IntPtr hit = Win.WindowFromPoint(p);
        if (hit == IntPtr.Zero || Belongs(hit, root)) return null;
        return "something else lies over the window at that point (" + Name(Flash.Root(hit)) + ")";
    }

    /** Whether a window is the borrowed one or of it: owned by it, or a bare popup of its process, which a menu is (it has no owner to say so, and no title bar). */
    static bool Belongs(IntPtr h, IntPtr root)
    {
        IntPtr top = Flash.Root(h);
        if (top == root) return true;
        return Desk.PidOf(top) == Desk.PidOf(root) && (Win.GetWindowLongPtr(top, -16).ToInt64() & 0x00C00000L) != 0x00C00000L; // no WS_CAPTION
    }

    static string Name(IntPtr h) { string title = Desk.TitleOf(h); return title.Length > 0 ? title : Desk.ClassOf(h); }

    /**
     * Input for the seat, through SendInput. Never while the user holds a modifier or a mouse button (a key-up sent then
     * would let go of theirs, and a click would become a ctrl+click), and, with `since` (the tick a borrow began at),
     * never once the user has touched the mouse or keyboard since, nor, with `root` (the borrowed window), once another
     * window has come in front of it or over the point a click is for: {ok: false, taken: why} instead, with any button
     * this input held let go. Long text is sent a batch at a time, asked again before each. "letgo" lets go of those
     * buttons only.
     */
    public static object Send()
    {
        string kind = Program.Str("kind");
        if (kind == "letgo") { LetGo(); return new Dictionary<string, object> { { "ok", true } }; }
        uint since = (uint)Program.Long("since");
        IntPtr root = new IntPtr(Program.Long("root"));
        string taken = Seat.Interrupted(since) ?? Moved(root);
        if (taken == null && (kind == "click" || kind == "wheel")) taken = Covered(root, Program.Int("x"), Program.Int("y"));
        if (taken == null && kind == "down") { Win.POINT at; Win.GetCursorPos(out at); taken = Covered(root, at.x, at.y); }
        if (taken != null)
        {
            LetGo();
            return new Dictionary<string, object> { { "ok", false }, { "taken", taken } };
        }
        List<INPUT> inputs = new List<INPUT>();
        bool right = Program.Str("button") == "right";
        uint down = right ? 0x0008u : 0x0002u, up = right ? 0x0010u : 0x0004u;
        switch (kind)
        {
            case "move": inputs.Add(MoveTo(Program.Int("x"), Program.Int("y"))); Seat.Cursor(Program.Int("x"), Program.Int("y")); break;
            case "down": inputs.Add(Mouse(down, 0, 0, 0)); Seat.Press(right ? 0x02 : 0x01); break;
            case "up": inputs.Add(Mouse(up, 0, 0, 0)); Seat.Release(right ? 0x02 : 0x01); break;
            case "click":
                inputs.Add(MoveTo(Program.Int("x"), Program.Int("y")));
                Seat.Cursor(Program.Int("x"), Program.Int("y"));
                for (int i = 0; i < Math.Max(1, Program.Int("count")); i++) { inputs.Add(Mouse(down, 0, 0, 0)); inputs.Add(Mouse(up, 0, 0, 0)); }
                break;
            case "wheel":
                inputs.Add(MoveTo(Program.Int("x"), Program.Int("y")));
                Seat.Cursor(Program.Int("x"), Program.Int("y"));
                if (Program.Int("delta") != 0) inputs.Add(Mouse(0x0800, 0, 0, (uint)Program.Int("delta")));
                if (Program.Int("horizontal") != 0) inputs.Add(Mouse(0x1000, 0, 0, (uint)Program.Int("horizontal")));
                break;
            case "key":
            {
                List<ushort> mods = new List<ushort>();
                foreach (object m in Program.Arr("modifiers")) mods.Add((ushort)Convert.ToInt32(m));
                ushort vk = (ushort)Program.Int("vk");
                foreach (ushort m in mods) inputs.Add(KeyInput(m, (ushort)Win.MapVirtualKey(m, 0), 0));
                inputs.Add(KeyInput(vk, (ushort)Win.MapVirtualKey(vk, 0), Extended(vk)));
                inputs.Add(KeyInput(vk, (ushort)Win.MapVirtualKey(vk, 0), Extended(vk) | 0x0002));
                for (int i = mods.Count - 1; i >= 0; i--) inputs.Add(KeyInput(mods[i], (ushort)Win.MapVirtualKey(mods[i], 0), 0x0002));
                break;
            }
            case "text":
            {
                string text = Program.Str("text");
                foreach (char c in text)
                {
                    if (c == '\n' || c == '\t')
                    {
                        ushort vk = c == '\n' ? (ushort)0x0D : (ushort)0x09;
                        inputs.Add(KeyInput(vk, (ushort)Win.MapVirtualKey(vk, 0), 0));
                        inputs.Add(KeyInput(vk, (ushort)Win.MapVirtualKey(vk, 0), 0x0002));
                    }
                    else if (c != '\r') { inputs.Add(KeyInput(0, c, 0x0004)); inputs.Add(KeyInput(0, c, 0x0004 | 0x0002)); } // KEYEVENTF_UNICODE
                    if (inputs.Count >= 64)
                    {
                        SendAll(inputs);
                        inputs.Clear();
                        Thread.Sleep(12);
                        // A long text takes a while: the user who touches anything meanwhile, or a window that comes in front, stops it here.
                        string cut = Seat.Interrupted(since) ?? Moved(root);
                        if (cut != null)
                        {
                            LetGo();
                            return new Dictionary<string, object> { { "ok", false }, { "taken", cut } };
                        }
                    }
                }
                break;
            }
            default: throw new ArgumentException("unknown input " + kind);
        }
        SendAll(inputs);
        return new Dictionary<string, object> { { "ok", true } };
    }
    static uint Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x2E) || vk == 0xA3 || vk == 0xA5 || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F ? 0x0001u : 0u; } // arrows, home/end, insert/delete, right ctrl/alt, win, apps, numpad divide

}

// ------------------------------------------------------------ a click into a Chromium window, from behind

/**
 * A posted click into a Chromium window makes Chrome bring that window forward: in front within 25 ms of the press,
 * every time, whatever the window's styles or the messages sent first (measured). Left so, it would sit over the
 * user's windows with their typing going into it. So such a click is guarded: the window the user has in front is
 * remembered as it begins, and for a moment after the click, whenever the Chromium window (or a window the click
 * opened: a page's pop-up, a sign-in) has the foreground or lies above that one, the foreground goes back and the
 * window behind again, at once. The window is in front for about 70 ms (68 ms median, measured). Bun takes the seat's
 * lock and waits for the user to pause before a guarded click (src/windows.ts), so that the moment cannot catch their
 * typing.
 */
static class Flash
{
    public const int QuietMs = 400; // the pause a guarded click needs: FLASH_QUIET_MS in src/windows.ts
    public const int WatchMs = 600; // after the handback, a while more, for a second take (a bubble, a focus change)
    const int SettleMs = 30; // after the release, before the first handback: Chrome finishes taking the foreground
    const int ShortMs = 150; // the watch of a click that more clicks follow: Chrome takes the foreground 5 to 11 ms after the press (measured)

    /** Said, word for word, when a click a guarded piece of work still had to make was not made: the tools know it by its start. */
    public const string Busy = "busy: the user went back to the mouse or keyboard before the field was ready, so nothing was typed";

    /**
     * One guarded moment: the window clicked and whether it goes back behind the user's (it is the hand's own), the
     * window the user had in front, the nearest ordinary window above the clicked one (where a window of the user's
     * goes back to), and the top-level windows its process had, which tell a window the click opens.
     */
    public class Moment { public IntPtr root, front, above; public bool sink; public uint pid; public HashSet<long> before; }

    static readonly object gate = new object();
    static Moment pending; // the moment under way, which Hold.Abandon undoes when the hand ends in the middle of it
    static Moment driven; // the moment Bun began with "guard", which its "guard" end closes

    public static Moment Begin(IntPtr root, bool sink)
    {
        Moment m = new Moment();
        m.root = root;
        m.sink = sink;
        m.front = Win.GetForegroundWindow();
        m.above = OrdinaryAbove(root);
        m.pid = Desk.PidOf(root);
        m.before = WindowsOf(m.pid);
        lock (gate) pending = m;
        return m;
    }

    public static void Driven(IntPtr root, bool sink) { driven = Begin(root, sink); }

    public static object EndDriven()
    {
        Moment m = driven;
        driven = null;
        if (m == null) return new Dictionary<string, object> { { "taken", false }, { "back", true }, { "popups", new object[0] } };
        return End(m);
    }

    /** The moment after the last click of a guarded piece of work, watched for a second take too: {taken, back, popups}. */
    public static Dictionary<string, object> End(Moment m) { Dictionary<string, object> r = Watch(m, SettleMs, WatchMs); Done(m); return r; }

    /** The moment after a click that more clicks follow: given back as soon as it is taken. */
    public static Dictionary<string, object> Return(Moment m) { Dictionary<string, object> r = Watch(m, 0, ShortMs); Done(m); return r; }

    /** A while more after a piece of work's last click, whose foreground is back already. */
    public static void Linger(Moment m) { Watch(m, 0, WatchMs); }

    static void Done(Moment m) { lock (gate) { if (pending == m) pending = null; } }

    /** The hand ends in the middle of a guarded moment: whatever the click brought forward gives the foreground back, once. */
    public static void Abandon()
    {
        Moment m;
        lock (gate) { m = pending; pending = null; driven = null; }
        if (m == null) return;
        IntPtr fg = Win.GetForegroundWindow();
        if (fg != IntPtr.Zero && fg != m.front && (Root(fg) == m.root || Opened(m, fg)) && m.front != IntPtr.Zero && Win.IsWindow(m.front)) Program.Activate(m.front);
        if (m.sink && Win.IsWindow(m.root) && Root(Win.GetForegroundWindow()) != m.root) Sink(m.root);
    }

    /** The window a window belongs to at the top: itself, or what owns it. */
    public static IntPtr Root(IntPtr h) { IntPtr r = Win.GetAncestor(h, 3); return r == IntPtr.Zero ? h : r; } // GA_ROOTOWNER

    static void Sink(IntPtr h) { Win.SetWindowPos(h, new IntPtr(1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); } // HWND_BOTTOM, no activation

    /** Whether `h` lies above `other` among the top-level windows. */
    static bool Above(IntPtr h, IntPtr other)
    {
        for (IntPtr at = Win.GetWindow(h, 2); at != IntPtr.Zero; at = Win.GetWindow(at, 2)) if (at == other) return true; // GW_HWNDNEXT
        return false;
    }

    /** The nearest visible window above `h` that does not stay on top: the one it lies under among the user's windows. */
    static IntPtr OrdinaryAbove(IntPtr h)
    {
        for (IntPtr at = Win.GetWindow(h, 3); at != IntPtr.Zero; at = Win.GetWindow(at, 3)) // GW_HWNDPREV
        {
            if (Win.IsWindowVisible(at) && (Win.GetWindowLongPtr(at, -20).ToInt64() & 0x8) == 0) return at; // not WS_EX_TOPMOST
        }
        return IntPtr.Zero;
    }

    /** A process's top-level windows now. */
    static HashSet<long> WindowsOf(uint pid)
    {
        HashSet<long> all = new HashSet<long>();
        for (IntPtr h = Win.GetTopWindow(IntPtr.Zero); h != IntPtr.Zero; h = Win.GetWindow(h, 2)) if (Desk.PidOf(h) == pid) all.Add(h.ToInt64());
        return all;
    }

    /** Whether a window is one the moment's click opened: its process's, new, and not owned by the window clicked. */
    static bool Opened(Moment m, IntPtr h)
    {
        IntPtr top = Root(h);
        return top != m.root && m.before != null && !m.before.Contains(top.ToInt64()) && Desk.PidOf(top) == m.pid;
    }

    /**
     * Watch the moment after a guarded click, and give back what it takes: {taken, back, popups}. The window goes
     * behind the user's again when it is the hand's own, and so does a window the click opened; a window of the user's
     * is only handed back, and put back under the window it lay under. A window that still has the foreground is never
     * sunk (the user would type into a window they cannot see): `back` then says the handback failed. `popups` are the
     * windows the click opened (a page's pop-up, a sign-in), with a title bar of their own, which the hand may adopt.
     */
    static Dictionary<string, object> Watch(Moment m, int settleMs, int ms)
    {
        Stopwatch clock = Stopwatch.StartNew();
        bool taken = false, back = true;
        while (clock.ElapsedMilliseconds < settleMs + ms)
        {
            IntPtr fg = Win.GetForegroundWindow();
            bool opened = fg != IntPtr.Zero && fg != m.front && Opened(m, fg);
            bool took = fg != IntPtr.Zero && fg != m.front && (Root(fg) == m.root || opened);
            bool over = m.sink && m.front != IntPtr.Zero && Win.IsWindow(m.front) && Above(m.root, m.front);
            if ((took || over) && clock.ElapsedMilliseconds >= settleMs)
            {
                taken |= took;
                if (took && m.front != IntPtr.Zero && Win.IsWindow(m.front)) back = Program.Activate(m.front);
                IntPtr now = Win.GetForegroundWindow();
                bool free = now == IntPtr.Zero || (Root(now) != m.root && !Opened(m, now));
                if (m.sink && free) Sink(m.root);
                if (m.sink && opened && free) Sink(Root(fg));
            }
            Thread.Sleep(5);
        }
        IntPtr last = Win.GetForegroundWindow();
        if (last != IntPtr.Zero && last != m.front && (Root(last) == m.root || Opened(m, last))) back = false; // every try failed: it still has the keyboard
        if (!m.sink && taken && back && m.above != IntPtr.Zero && m.above != m.root && Win.IsWindow(m.above))
            Win.SetWindowPos(m.root, m.above, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // the user's window, back where it lay: activation raised it over the rest of theirs
        List<object> popups = new List<object>();
        foreach (long h in WindowsOf(m.pid))
        {
            IntPtr w = new IntPtr(h);
            if (m.before.Contains(h) || !Win.IsWindowVisible(w) || Root(w) == m.root) continue;
            long style = Win.GetWindowLongPtr(w, -16).ToInt64(), ex = Win.GetWindowLongPtr(w, -20).ToInt64();
            if ((style & 0x00C00000L) == 0x00C00000L && (ex & 0x80) == 0) popups.Add(h); // a title bar, and not a tool window: a window of its own
        }
        return new Dictionary<string, object> { { "taken", taken }, { "back", back }, { "popups", popups } };
    }
}

// ------------------------------------------------------------ the seat, as a hand borrows it

/**
 * What a borrow of the seat needs to know (src/windows-seat.ts): how long the user has left the mouse and keyboard
 * alone, what they are holding, and whether they have touched anything since a borrow began. GetLastInputInfo counts
 * the helper's own SendInput too, so the tick after each is kept, and input that soon after it is taken for the helper's.
 */
static class Seat
{
    const uint Slack = 50; // ms after the helper's own input within which the last input is taken for it: three of the clock's 15.6 ms ticks
    const int Wander = 4; // px the cursor may be from where the helper's input left it before the user is taken to have moved it

    static uint injectedAt; // the tick after the helper's last SendInput, 0 before any
    static uint userAt; // the tick of the latest input known to be the user's
    static uint borrowSince; // the borrow `cursor` belongs to
    static int[] cursor; // where the helper's pointer input left the cursor during that borrow, while it is known
    static readonly List<int> pressed = new List<int>(); // mouse buttons (VK_LBUTTON, VK_RBUTTON) the helper's input holds down

    static readonly int[] HeldKeys = { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0x01, 0x02, 0x04, 0x05, 0x06 };
    static readonly string[] HeldNames = { "shift", "ctrl", "alt", "win", "win", "the left mouse button", "the right mouse button", "the middle mouse button", "a mouse button", "a mouse button" };

    static bool After(uint a, uint b) { return (int)(a - b) > 0; }

    static uint LastInput()
    {
        Win.LASTINPUTINFO info = new Win.LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(Win.LASTINPUTINFO));
        return Win.GetLastInputInfo(ref info) ? info.dwTime : Win.GetTickCount();
    }

    /** The modifiers and mouse buttons the user is holding down: not a button the helper's own input is holding. */
    static List<object> Held()
    {
        List<object> held = new List<object>();
        for (int i = 0; i < HeldKeys.Length; i++)
        {
            if ((Win.GetAsyncKeyState(HeldKeys[i]) & 0x8000) == 0 || pressed.Contains(HeldKeys[i])) continue;
            if (!held.Contains(HeldNames[i])) held.Add(HeldNames[i]);
        }
        return held;
    }

    /**
     * {idleMs, held, quiet, state, tick}: how long since the user last touched the mouse or keyboard, what they hold, and
     * whether the shell says they are not to be disturbed (SHQueryUserNotificationState: away or locked, a full-screen
     * app, a D3D game, a presentation), with the tick it was asked at.
     */
    public static object Idle()
    {
        uint now = Win.GetTickCount();
        uint idle = IdleMs(now);
        int state = 0;
        try { Win.SHQueryUserNotificationState(out state); } catch (Exception) { }
        bool quiet = state != 1 && state != 2 && state != 3 && state != 4;
        return new Dictionary<string, object> { { "idleMs", (long)idle }, { "held", Held() }, { "quiet", quiet }, { "state", state }, { "tick", (long)now } };
    }

    /** Milliseconds from the user's last input to `now`, the helper's own aside. */
    static uint IdleMs(uint now)
    {
        uint last = LastInput();
        if (userAt == 0 || injectedAt == 0 || After(last, injectedAt + Slack)) userAt = last;
        return (uint)(now - userAt);
    }

    /** Whether the user has left the mouse and keyboard alone for `quietMs`, holding nothing: asked again before each click of a guarded piece of work that takes a while. */
    public static bool Paused(int quietMs)
    {
        return IdleMs(Win.GetTickCount()) >= quietMs && Held().Count == 0;
    }

    /** Why the helper must not inject now, or null: the user holds something, or, since `since` (0: no borrow), touched anything. */
    public static string Interrupted(uint since)
    {
        List<object> held = Held();
        if (held.Count > 0) return "the user is holding " + held[0];
        if (since == 0) return null;
        if (since != borrowSince) { borrowSince = since; cursor = null; }
        uint last = LastInput();
        if (After(last, since) && (injectedAt == 0 || After(last, injectedAt + Slack))) return "the user moved the mouse or typed";
        if (cursor != null)
        {
            Win.POINT p;
            Win.GetCursorPos(out p);
            if (Math.Abs(p.x - cursor[0]) > Wander || Math.Abs(p.y - cursor[1]) > Wander) return "the user moved the mouse";
        }
        return null;
    }

    public static void Injected() { injectedAt = Win.GetTickCount(); if (injectedAt == 0) injectedAt = 1; }
    public static void Cursor(int x, int y) { cursor = new int[] { x, y }; }
    public static void Press(int button) { if (!pressed.Contains(button)) pressed.Add(button); }
    public static void Release(int button) { pressed.Remove(button); }
    public static int[] Pressed() { return pressed.ToArray(); }
    public static void Released() { pressed.Clear(); }

    /**
     * The cursor put back where the user left it; counted as the helper's own input, in case the system counts it at
     * all. With `unlessMoved`, only while it is still where the helper's own input left it (or, when that sent none,
     * where it is to go): a user who has taken the mouse back is not fought for it.
     */
    public static object SetCursor(int x, int y, bool unlessMoved)
    {
        if (unlessMoved)
        {
            Win.POINT p;
            Win.GetCursorPos(out p);
            int ex = cursor != null ? cursor[0] : x, ey = cursor != null ? cursor[1] : y;
            if (Math.Abs(p.x - ex) > Wander || Math.Abs(p.y - ey) > Wander)
            {
                cursor = null;
                return new Dictionary<string, object> { { "ok", false }, { "moved", true } };
            }
        }
        bool ok = Win.SetCursorPos(x, y);
        Injected();
        cursor = null;
        return new Dictionary<string, object> { { "ok", ok } };
    }
}

// ------------------------------------------------------------ what a hand has out, given back however it ends

/**
 * A borrow of the seat under way (src/windows.ts borrow), known here as well as in Bun, so that it is given back
 * however the hand ends: the window the user had in front, where their cursor was, the window borrowed, and whether
 * that goes back behind the user's windows. "holding" says a borrow has begun, "free" that Bun has put everything back
 * itself, and "abandon" (Bun about to leave in the middle of one) puts back whatever is out, as the helper's own end
 * does (Program.Leave).
 */
static class Hold
{
    static bool holding;
    static IntPtr before, root;
    static int x, y;
    static bool sink;

    public static object Command(string state)
    {
        if (state == "holding")
        {
            before = new IntPtr(Program.Long("before"));
            root = new IntPtr(Program.Long("root"));
            x = Program.Int("x");
            y = Program.Int("y");
            sink = Program.Bool("sink");
            holding = true;
        }
        else if (state == "free") holding = false;
        else if (state == "abandon") Abandon();
        else throw new ArgumentException("unknown seat state " + state);
        return new Dictionary<string, object> { { "ok", true } };
    }

    /**
     * Let go of any mouse button the helper's input holds, give back the moment of a guarded click, and then the borrow:
     * the user's window in front again unless they have gone to another, their cursor back unless they have moved it,
     * and the borrowed window behind theirs when it is the hand's own. Nothing here throws.
     */
    public static void Abandon()
    {
        try { Input.LetGo(); } catch (Exception) { }
        try { Flash.Abandon(); } catch (Exception) { }
        if (!holding) return;
        holding = false;
        try
        {
            IntPtr fg = Win.GetForegroundWindow();
            if (before != IntPtr.Zero && Win.IsWindow(before) && fg != IntPtr.Zero && Flash.Root(fg) == root) Program.Activate(before);
            Seat.SetCursor(x, y, true);
            if (sink && Win.IsWindow(root)) Win.SetWindowPos(root, new IntPtr(1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // HWND_BOTTOM, no activation
        }
        catch (Exception) { }
    }
}

/**
 * A hand's browser windows parked past the right edge of every screen (src/windows.ts park), each with the window
 * rectangle it had, invisible borders and all, so that it goes back exactly where it was, a maximized one too, and
 * still goes back when Bun is gone. A window no helper here parked, found on no screen at all (its hand's helper went
 * without a word), is brought onto the primary one instead.
 */
static class Parking
{
    const int GapPx = 64; // past the right edge of the virtual screen: no screen shows it, and it lies on none

    class Spot { public uint pid; public Win.RECT rect; }
    static readonly Dictionary<long, Spot> parked = new Dictionary<long, Spot>();

    /** Off the screens, with where it was kept (the first time: a borrow unparks it and parks it again). */
    public static object Park(IntPtr hwnd)
    {
        if (!Win.IsWindow(hwnd)) return new Dictionary<string, object> { { "ok", false }, { "gone", true } };
        Spot spot;
        if (!parked.TryGetValue(hwnd.ToInt64(), out spot) || spot.pid != Desk.PidOf(hwnd))
        {
            spot = new Spot();
            spot.pid = Desk.PidOf(hwnd);
            spot.rect = Normal(hwnd);
            parked[hwnd.ToInt64()] = spot;
        }
        Win.RECT to = spot.rect;
        int width = to.R - to.L;
        to.L = Win.GetSystemMetrics(76) + Win.GetSystemMetrics(78) + GapPx; // SM_XVIRTUALSCREEN + SM_CXVIRTUALSCREEN
        to.R = to.L + width;
        Place(hwnd, to);
        return new Dictionary<string, object> { { "ok", true }, { "x", to.L }, { "y", to.T } };
    }

    /**
     * Back where it was before it was parked; with `keep`, still counted as parked, to go back after (a borrow). A
     * window this helper never parked is moved only when it lies on no screen: onto the primary one's work area,
     * keeping its size where that fits. {how: "restored" | "rescued" | "none"}.
     */
    public static object Unpark(IntPtr hwnd, bool keep)
    {
        Spot spot;
        string how = "none";
        if (parked.TryGetValue(hwnd.ToInt64(), out spot) && Win.IsWindow(hwnd) && spot.pid == Desk.PidOf(hwnd))
        {
            if (!keep) parked.Remove(hwnd.ToInt64());
            Place(hwnd, spot.rect);
            how = "restored";
        }
        else
        {
            parked.Remove(hwnd.ToInt64()); // gone, or its handle is another window's now
            if (Win.IsWindow(hwnd) && OnNoScreen(hwnd)) { Rescue(hwnd); how = "rescued"; }
        }
        return new Dictionary<string, object> { { "ok", true }, { "how", how } };
    }

    /** As the helper leaves: every window still parked goes back where it was, behind the user's windows. Nothing here throws. */
    public static void ComeBack()
    {
        foreach (KeyValuePair<long, Spot> p in parked)
        {
            try
            {
                IntPtr h = new IntPtr(p.Key);
                if (!Win.IsWindow(h) || Desk.PidOf(h) != p.Value.pid) continue;
                Place(h, p.Value.rect);
                Win.SetWindowPos(h, new IntPtr(1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // HWND_BOTTOM, no activation
            }
            catch (Exception) { }
        }
        parked.Clear();
    }

    static bool OnNoScreen(IntPtr h)
    {
        Win.RECT r = Normal(h);
        return Win.MonitorFromRect(ref r, 0) == IntPtr.Zero; // MONITOR_DEFAULTTONULL
    }

    static void Rescue(IntPtr h)
    {
        Win.RECT r = Normal(h);
        Win.POINT origin = new Win.POINT();
        Win.MONITORINFO info = new Win.MONITORINFO();
        info.cbSize = Marshal.SizeOf(typeof(Win.MONITORINFO));
        if (!Win.GetMonitorInfo(Win.MonitorFromPoint(origin, 1), ref info)) return; // MONITOR_DEFAULTTOPRIMARY
        Win.RECT work = info.rcWork;
        int w = Math.Min(r.R - r.L, work.R - work.L), height = Math.Min(r.B - r.T, work.B - work.T);
        Win.RECT to;
        to.L = work.L + (work.R - work.L - w) / 2;
        to.T = work.T + (work.B - work.T - height) / 2;
        to.R = to.L + w;
        to.B = to.T + height;
        Place(h, to);
    }

    /** A window's rectangle in screen coordinates, invisible borders and all; a minimized one's, where it goes back to. */
    static Win.RECT Normal(IntPtr h)
    {
        Win.RECT r;
        if (!Win.IsIconic(h)) { Win.GetWindowRect(h, out r); return r; }
        Win.WINDOWPLACEMENT p = Placement(h);
        int dx, dy;
        WorkspaceOffset(p.rcNormalPosition, out dx, out dy);
        r = p.rcNormalPosition;
        r.L += dx; r.R += dx; r.T += dy; r.B += dy;
        return r;
    }

    /** A window put at a rectangle without activation or a change of its place in the stack; a minimized one stays minimized, and goes back there. */
    static void Place(IntPtr h, Win.RECT r)
    {
        if (!Win.IsIconic(h))
        {
            Win.SetWindowPos(h, IntPtr.Zero, r.L, r.T, r.R - r.L, r.B - r.T, 0x0004 | 0x0010); // NOZORDER | NOACTIVATE
            return;
        }
        Win.WINDOWPLACEMENT p = Placement(h);
        int dx, dy;
        WorkspaceOffset(r, out dx, out dy);
        r.L -= dx; r.R -= dx; r.T -= dy; r.B -= dy;
        p.rcNormalPosition = r;
        Win.SetWindowPlacement(h, ref p);
    }

    static Win.WINDOWPLACEMENT Placement(IntPtr h)
    {
        Win.WINDOWPLACEMENT p = new Win.WINDOWPLACEMENT();
        p.length = Marshal.SizeOf(typeof(Win.WINDOWPLACEMENT));
        Win.GetWindowPlacement(h, ref p);
        return p;
    }

    /** How far a placement's workspace coordinates lie from screen ones, on the monitor of `r`: its work area's corner less its own. */
    static void WorkspaceOffset(Win.RECT r, out int dx, out int dy)
    {
        dx = 0;
        dy = 0;
        Win.MONITORINFO info = new Win.MONITORINFO();
        info.cbSize = Marshal.SizeOf(typeof(Win.MONITORINFO));
        if (!Win.GetMonitorInfo(Win.MonitorFromRect(ref r, 1), ref info)) return; // MONITOR_DEFAULTTOPRIMARY
        dx = info.rcWork.L - info.rcMonitor.L;
        dy = info.rcWork.T - info.rcMonitor.T;
    }
}

// ------------------------------------------------------------ a page, in a window of an app

/**
 * Whether a window shows a web page drawn by Chromium, where Enter sends a chat message: its own class is Chromium's
 * (a browser, an Electron app), or a WebView2 it hosts fills most of it (new Teams, new Outlook, WhatsApp), whose render
 * widget is a child window of another process. A WebView2 that is only a pane of an app (one of Office's) does not
 * make the app a page.
 */
static class Web
{
    public static bool Hosts(IntPtr top)
    {
        if (Uia.IsChromium(top)) return true;
        Win.RECT frame;
        if (!Win.GetWindowRect(top, out frame)) return false;
        long whole = (long)(frame.R - frame.L) * (frame.B - frame.T);
        long page = 0;
        Win.EnumChildWindows(top, delegate (IntPtr c, IntPtr l)
        {
            if (!Win.IsWindowVisible(c)) return true;
            string cls = Desk.ClassOf(c);
            if (cls != "Chrome_RenderWidgetHostHWND" && !cls.StartsWith("Chrome_WidgetWin", StringComparison.Ordinal)) return true;
            Win.RECT r;
            Win.GetWindowRect(c, out r);
            page = Math.Max(page, (long)(r.R - r.L) * (r.B - r.T));
            return true;
        }, IntPtr.Zero);
        return whole > 0 && page * 2 >= whole;
    }

    /** Whether any visible top-level window of a process shows a page (see Hosts). */
    public static bool OfProcess(uint pid)
    {
        for (IntPtr h = Win.GetTopWindow(IntPtr.Zero); h != IntPtr.Zero; h = Win.GetWindow(h, 2))
            if (Win.IsWindowVisible(h) && Desk.PidOf(h) == pid && Hosts(h)) return true;
        return false;
    }
}

// ------------------------------------------------------------ Win32

static class Win
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFOHEADER { public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount; public uint biCompression, biSizeImage; public int biXPelsPerMeter, biYPelsPerMeter; public uint biClrUsed, biClrImportant; }
    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO { public int cbSize; public uint flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SHELLEXECUTEINFO
    {
        public int cbSize; public uint fMask; public IntPtr hwnd; public string lpVerb, lpFile, lpParameters, lpDirectory;
        public int nShow; public IntPtr hInstApp, lpIDList; public string lpClass; public IntPtr hkeyClass; public uint dwHotKey; public IntPtr hIcon; public IntPtr hProcess;
    }
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize, dwTime; }
    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT { public int length, flags, showCmd; public POINT ptMinPosition, ptMaxPosition; public RECT rcNormalPosition; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PROCESSENTRY32
    {
        public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    public delegate bool EnumProc(IntPtr hwnd, IntPtr l);

    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT p);
    [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT p);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref RECT r, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT p, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeoutText(IntPtr hwnd, uint msg, IntPtr w, string l, uint flags, uint ms, out IntPtr result);
    [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)] public static extern uint AssocQueryString(uint flags, uint str, string assoc, string extra, StringBuilder outp, ref uint size);
    [DllImport("kernel32.dll")] public static extern uint GetTickCount();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern int GetPackageFamilyName(IntPtr process, ref uint length, StringBuilder name);
    [DllImport("kernel32.dll")] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode)] public static extern bool Process32First(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode)] public static extern bool Process32Next(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int i);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hwnd, ref POINT p);
    [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT p, uint flags);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll", EntryPoint = "PostMessageW")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", EntryPoint = "SendMessageW")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageText(IntPtr hwnd, uint msg, IntPtr w, string l);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int v, int size);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT v, int size);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] public static extern int GetProcessId(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool ShellExecuteEx(ref SHELLEXECUTEINFO info);
}
