// The native half of windows.ts: one process, "hands-<exe> serve", answering JSON over a named pipe.
//
// Bun calls it synchronously over bun:ffi (kernel32 WriteFile/ReadFile), so a request is one JSON object
// {cmd, ...} and its reply one JSON object, each framed as a 4-byte little-endian length. The process ends
// when the pipe breaks or its stdin closes: whichever way Bun goes, the helper goes with it.
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

    static int Main(string[] args)
    {
        string mode = args.Length > 0 ? args[0] : "";
        if (mode == "hand") return Hand.Run(args);
        if (mode != "serve") { Console.Error.WriteLine("usage: hands-win serve | hand ..."); return 2; }
        try { Win.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
        string name = "hands-" + Process.GetCurrentProcess().Id;
        Thread watch = new Thread(delegate ()
        {
            try { Stream input = Console.OpenStandardInput(); byte[] b = new byte[64]; while (input.Read(b, 0, b.Length) > 0) { } } catch (Exception) { }
            stop = true;
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
                    try { reply = json.Serialize(Dispatch(Encoding.UTF8.GetString(body, 0, len))); }
                    catch (Exception e) { reply = json.Serialize(new Dictionary<string, object> { { "error", e.GetType().Name + ": " + e.Message } }); }
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
        return 0;
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
    static bool Bool(string key) { object v; return req.TryGetValue(key, out v) && v is bool && (bool)v; }
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
            case "foreground": return Foreground();
            case "displays": return Displays();
            case "windows": return Desk.List();
            case "processes": return Processes(Str("exe"));
            case "exe": return Exe(Int("pid"));
            case "launch": return Launch(Str("file"), Str("args"), Has("show") ? Int("show") : 4);
            case "activate": return new Dictionary<string, object> { { "ok", Activate(Hwnd()) } };
            case "move": return Move();
            case "show": Win.ShowWindow(Hwnd(), Win.IsIconic(Hwnd()) ? 4 : 8); return Ok();
            case "close": Win.PostMessage(Hwnd(), 0x0010, IntPtr.Zero, IntPtr.Zero); return Ok();
            case "topmost": Win.SetWindowPos(Hwnd(), new IntPtr(Bool("on") ? -1 : -2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); return Ok();
            case "sink": Win.SetWindowPos(Hwnd(), new IntPtr(1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); return Ok(); // HWND_BOTTOM: behind every window of the user's, without activation
            case "capture": return Capture.Take();
            case "image": return Capture.Size(Str("path"));
            case "ocr": return Ocr.Read(Str("path"), Arr("rect"));
            case "tree": return Uia.Tree(Hwnd(), Has("cap") ? Int("cap") : 4000, Has("ms") ? Int("ms") : 600);
            case "focused": return Uia.Focused();
            case "act": return Uia.Act(Int("id"), Str("action"));
            case "setValue": return Uia.SetValue(Int("id"), Str("text"));
            case "value": return Uia.Value(Int("id"));
            case "release": Uia.Release(); return Ok();
            case "post": return Input.Post(Hwnd(), Str("kind"), Int("x"), Int("y"));
            case "chars": return Input.Chars(Hwnd(), Str("text"));
            case "vkey": return Input.VKey(Hwnd(), Int("vk"));
            case "wheel": return Input.Wheel(Hwnd(), Int("x"), Int("y"), Int("delta"), Bool("horizontal"));
            case "input": return Input.Send();
            case "clipboard": return Clipboard(Str("text"));
            case "browser": return Uia.Browser(Hwnd());
            case "menu": return Uia.Menu(Hwnd(), Arr("path"));
            case "scrollPage": return Uia.ScrollPage(Hwnd(), Str("direction"));
            case "reg": return Reg(Str("key"), Str("name"));
            case "desktop": return Desktops.Ensure(Str("name"));
            case "desktops": return Desktops.Names();
            case "send": Desktops.Need(Str("name")).MoveWindow(Hwnd(), true); return Ok();
            case "removeDesktop": return Desktops.Remove(Str("name"));
            case "switch": Desktops.Need(Str("name")).MakeVisible(); return Ok();
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

    /** Main processes of one executable, with their command lines: WMI is the one API that reads another process's arguments without debugging it. */
    static object Processes(string exe)
    {
        List<object> outp = new List<object>();
        string query = "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = '" + exe.Replace("'", "''") + "'";
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
        IntPtr h = Win.OpenProcess(0x1000, false, (uint)pid);
        string path = "";
        if (h != IntPtr.Zero)
        {
            try { StringBuilder b = new StringBuilder(1024); int n = 1024; if (Win.QueryFullProcessImageName(h, 0, b, ref n)) path = b.ToString(0, n); }
            finally { Win.CloseHandle(h); }
        }
        if (path.Length == 0) { try { path = Process.GetProcessById(pid).ProcessName + ".exe"; } catch (Exception) { } }
        return new Dictionary<string, object> { { "name", Path.GetFileNameWithoutExtension(path) }, { "path", path } };
    }

    /** ShellExecuteEx with SW_SHOWNOACTIVATE: the app opens without the foreground moving. The pid can be a stub's (notepad, calc). */
    static object Launch(string file, string args, int show)
    {
        Win.SHELLEXECUTEINFO info = new Win.SHELLEXECUTEINFO();
        info.cbSize = Marshal.SizeOf(typeof(Win.SHELLEXECUTEINFO));
        info.fMask = 0x40 | 0x100 | 0x400; // NOCLOSEPROCESS | NOASYNC | FLAG_NO_UI
        info.lpFile = file;
        info.lpParameters = args;
        info.nShow = show;
        if (!Win.ShellExecuteEx(ref info)) throw new Exception("cannot start " + file + " (error " + Marshal.GetLastWin32Error() + ")");
        int pid = info.hProcess != IntPtr.Zero ? Win.GetProcessId(info.hProcess) : 0;
        if (info.hProcess != IntPtr.Zero) Win.CloseHandle(info.hProcess);
        return new Dictionary<string, object> { { "pid", pid } };
    }

    /**
     * Bring a window to the front. SetForegroundWindow from a process that is not in front is refused; attached to the
     * input queue of the thread that is, it is allowed. Measured live on this machine: that is how the seat is handed back.
     */
    public static bool Activate(IntPtr hwnd)
    {
        if (Win.IsIconic(hwnd)) Win.ShowWindow(hwnd, 9);
        if (Win.GetForegroundWindow() == hwnd) return true;
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

    /**
     * Ordinary windows front to back: visible, not minimized, not a tool window, bigger than a palette, not the shell's.
     * A window the shell cloaks because it lies on another virtual desktop (DWM_CLOAKED_SHELL) is listed with `cloaked`
     * true: a hand's own window on the hand's desktop. Any other cloaked window (a suspended UWP app's) is left out.
     */
    public static object List()
    {
        List<object> outp = new List<object>();
        for (IntPtr h = Win.GetTopWindow(IntPtr.Zero); h != IntPtr.Zero; h = Win.GetWindow(h, 2))
        {
            if (!Win.IsWindowVisible(h) || Win.IsIconic(h)) continue;
            int cloaked = Cloaked(h);
            if ((Win.GetWindowLongPtr(h, -20).ToInt64() & 0x80) != 0 || (cloaked != 0 && cloaked != 2)) continue;
            Win.RECT r = Frame(h);
            if (r.R - r.L <= 50 || r.B - r.T <= 50) continue;
            string cls = ClassOf(h);
            if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") continue;
            Entry e = Describe(h);
            outp.Add(new Dictionary<string, object> {
                { "hwnd", h.ToInt64() }, { "pid", e.pid }, { "cls", cls }, { "title", e.title },
                { "frame", new object[] { r.L, r.T, r.R - r.L, r.B - r.T } }, { "core", e.core.ToInt64() }, { "cloaked", cloaked != 0 },
            });
        }
        return outp;
    }
}

// ------------------------------------------------------------ virtual desktops

/** A desktop per hand, through the shell's internal interfaces (src/vendor/VirtualDesktop11-24H2.cs): the public IVirtualDesktopManager moves only its own process's windows. */
static class Desktops
{
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
        }
        return new Dictionary<string, object> { { "index", VirtualDesktop.Desktop.FromDesktop(d) }, { "created", created } };
    }

    public static object Names()
    {
        List<object> names = new List<object>();
        for (int i = 0; i < VirtualDesktop.Desktop.Count; i++) names.Add(VirtualDesktop.Desktop.DesktopNameFromIndex(i));
        return names;
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
        if (loaded != null) loaded.Dispose();
        loaded = fresh;
        loadedPath = path;
        return loaded;
    }

    public static object Size(string path)
    {
        System.Drawing.Bitmap b = Load(path);
        return new Dictionary<string, object> { { "width", b.Width }, { "height", b.Height } };
    }

    /**
     * One window by PrintWindow(PW_RENDERFULLCONTENT), which DWM renders whole whether or not other windows cover it,
     * cropped to the frame the user sees; or one display by BitBlt. A minimized window has nothing to render, so it is
     * restored (without activation) first.
     */
    public static object Take()
    {
        string path = Program.Str("path");
        string format = Program.Str("format");
        int max = Program.Int("max");
        System.Drawing.Bitmap shot;
        if (Program.Has("hwnd"))
        {
            IntPtr hwnd = new IntPtr(Program.Long("hwnd"));
            if (Win.IsIconic(hwnd)) { Win.ShowWindow(hwnd, 4); Thread.Sleep(400); }
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
                    shot = whole.Clone(crop, PixelFormat.Format32bppRgb);
                }
            }
            finally { Win.SelectObject(dc, old); Win.DeleteObject(dib); Win.DeleteDC(dc); }
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
        using (shot)
        {
            System.Drawing.Bitmap saved = shot;
            if (max > 0 && shot.Width > max) saved = new System.Drawing.Bitmap(shot, new System.Drawing.Size(max, Math.Max(1, shot.Height * max / shot.Width)));
            try
            {
                if (format == "jpeg")
                {
                    ImageCodecInfo codec = null;
                    foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
                    EncoderParameters p = new EncoderParameters(1);
                    p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 80L);
                    saved.Save(path, codec, p);
                }
                else saved.Save(path, ImageFormat.Png);
                return new Dictionary<string, object> { { "width", saved.Width }, { "height", saved.Height } };
            }
            finally { if (saved != shot) saved.Dispose(); }
        }
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
        nodes.Add(new Dictionary<string, object> {
            { "id", id }, { "parent", parent }, { "role", Role(type, editable, inMenuBar) }, { "label", label },
            { "frame", FrameOf(el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty, true)) }, { "actions", actions },
        });
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

    delegate string Work();
    static string Timed(Work work)
    {
        string result = null;
        Exception failure = null;
        Thread thread = new Thread(delegate () { try { result = work(); } catch (Exception e) { failure = e; } });
        thread.IsBackground = true;
        thread.Start();
        if (!thread.Join(ActTimeoutMs)) return "ok"; // it opened something modal and is waiting for it; the next look will show what
        if (failure != null) throw failure;
        return result;
    }

    public static object Act(int id, string action)
    {
        Node n = Of(id);
        string result;
        if (action == "AXPress")
        {
            if (n.chromium) result = ClickOn(n, 1) ? "ok" : "no rect";
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
        else if (action == "AXConfirm") { Input.VKey(n.root, 0x0D); result = "ok"; }
        else if (action == "AXScrollToVisible")
        {
            object p;
            if (n.element.TryGetCurrentPattern(ScrollItemPattern.Pattern, out p)) { ((ScrollItemPattern)p).ScrollIntoView(); result = "ok"; }
            else result = "the element cannot scroll into view";
        }
        else result = "unknown action " + action;
        return new Dictionary<string, object> { { "ok", result == "ok" }, { "why", result } };
    }

    /**
     * A field's text. A classic edit control takes it as messages (select all, replace), which is what typing does and
     * takes no focus. Chromium takes focus on a posted click (three: the whole text selected) and the characters posted.
     * Anything else takes ValuePattern, which on some apps focuses the control but not the window.
     */
    public static object SetValue(int id, string text)
    {
        Node n = Of(id);
        string result = Timed(delegate
        {
            object handle = n.element.GetCurrentPropertyValue(AutomationElement.NativeWindowHandleProperty, true);
            IntPtr window = handle is int && (int)handle != 0 ? new IntPtr((int)handle) : IntPtr.Zero;
            string kind = window != IntPtr.Zero ? Desk.ClassOf(window) : "";
            if (kind == "Edit" || kind.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase))
            {
                Win.SendMessage(window, 0x00B1, IntPtr.Zero, new IntPtr(-1)); // EM_SETSEL
                Win.SendMessageText(window, 0x00C2, new IntPtr(1), text); // EM_REPLACESEL
                return "ok";
            }
            if (n.chromium)
            {
                if (!ClickOn(n, 3)) return "no rect";
                Thread.Sleep(60);
                Input.Chars(n.root, text);
                return "ok";
            }
            object p;
            if (!n.element.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return "the element takes no value";
            ((ValuePattern)p).SetValue(text);
            return "ok";
        });
        return new Dictionary<string, object> { { "ok", result == "ok" }, { "why", result } };
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

    /** A menu command by its path off the menu bar. Opening a menu shows it on screen: on Windows an item is pressed only where it is open. */
    public static object Menu(IntPtr hwnd, object[] path)
    {
        AutomationElement window = AutomationElement.FromHandle(hwnd);
        AutomationElement bar = window.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuBar));
        if (bar == null) throw new Exception("this app has no menu bar to press");
        List<AutomationElement> items = MenuItems(bar);
        AutomationElement at = null;
        for (int depth = 0; depth < path.Length; depth++)
        {
            string name = Convert.ToString(path[depth]);
            AutomationElement found = null;
            foreach (AutomationElement item in items) if (Plain(Name(item)) == Plain(name)) { found = item; break; }
            if (found == null) throw new Exception("no " + json.Serialize(name) + " in " + (depth == 0 ? "the menu bar" : JoinPath(path, depth)) + "; it has: " + string.Join(", ", Names(items).ToArray()));
            if (!found.Current.IsEnabled) throw new Exception(JoinPath(path, depth + 1) + " is unavailable right now. An app dims commands that have nothing to act on: put its cursor or selection where the command applies first.");
            HashSet<long> before = TopWindows();
            Press(found);
            at = found;
            Thread.Sleep(400);
            items = OpenedItems(found, before);
            if (items.Count == 0 && depth < path.Length - 1) throw new Exception(JoinPath(path, depth + 1) + " opened no menu");
        }
        if (at == null || items.Count > 0) return new Dictionary<string, object> { { "items", Names(items) } };
        return new Dictionary<string, object> { { "pressed", JoinPath(path, path.Length) } };
    }
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static string JoinPath(object[] path, int count) { List<string> parts = new List<string>(); for (int i = 0; i < count; i++) parts.Add(Convert.ToString(path[i])); return string.Join(" > ", parts.ToArray()); }
    static void Press(AutomationElement item)
    {
        object p;
        if (item.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { ((ExpandCollapsePattern)p).Expand(); return; }
        if (item.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return; }
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

    /** Where keys go: the window the app's own thread says has the focus, a UWP app's CoreWindow, or the window itself. */
    static IntPtr KeyTarget(IntPtr top)
    {
        Win.GUITHREADINFO info = new Win.GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(Win.GUITHREADINFO));
        uint pid; uint thread = Win.GetWindowThreadProcessId(top, out pid);
        if (Win.GetGUIThreadInfo(thread, ref info) && info.hwndFocus != IntPtr.Zero && (info.hwndFocus == top || Win.IsChild(top, info.hwndFocus))) return info.hwndFocus;
        IntPtr core = Desk.CoreOf(top);
        return core != IntPtr.Zero ? core : top;
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

    /** Text as WM_CHAR, one message a character: a key down as well would type twice in Chrome. Newlines and tabs go as keys. */
    public static object Chars(IntPtr top, string text)
    {
        IntPtr target = KeyTarget(top);
        foreach (char c in text)
        {
            if (c == '\n') Key(target, 0x0D);
            else if (c == '\t') Key(target, 0x09);
            else if (c != '\r') Win.PostMessage(target, 0x0102, new IntPtr(c), new IntPtr(1));
            Thread.Sleep(12);
        }
        return new Dictionary<string, object> { { "ok", true }, { "target", target.ToInt64() } };
    }

    static void Key(IntPtr target, int vk)
    {
        uint scan = Win.MapVirtualKey((uint)vk, 0);
        Win.PostMessage(target, 0x0100, new IntPtr(vk), new IntPtr((long)(1 | (scan << 16))));
        Win.PostMessage(target, 0x0101, new IntPtr(vk), new IntPtr((long)(1 | (scan << 16) | (0xC0u << 24))));
    }

    public static object VKey(IntPtr top, int vk)
    {
        IntPtr target = KeyTarget(top);
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
        if (sent != inputs.Count) throw new Exception("SendInput sent " + sent + " of " + inputs.Count + " (error " + Marshal.GetLastWin32Error() + ")");
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

    public static object Send()
    {
        string kind = Program.Str("kind");
        List<INPUT> inputs = new List<INPUT>();
        bool right = Program.Str("button") == "right";
        uint down = right ? 0x0008u : 0x0002u, up = right ? 0x0010u : 0x0004u;
        switch (kind)
        {
            case "move": inputs.Add(MoveTo(Program.Int("x"), Program.Int("y"))); break;
            case "down": inputs.Add(Mouse(down, 0, 0, 0)); break;
            case "up": inputs.Add(Mouse(up, 0, 0, 0)); break;
            case "click":
                inputs.Add(MoveTo(Program.Int("x"), Program.Int("y")));
                for (int i = 0; i < Math.Max(1, Program.Int("count")); i++) { inputs.Add(Mouse(down, 0, 0, 0)); inputs.Add(Mouse(up, 0, 0, 0)); }
                break;
            case "wheel":
                inputs.Add(MoveTo(Program.Int("x"), Program.Int("y")));
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
                    if (inputs.Count >= 64) { SendAll(inputs); inputs.Clear(); Thread.Sleep(12); }
                }
                break;
            }
            default: throw new ArgumentException("unknown input " + kind);
        }
        SendAll(inputs);
        return new Dictionary<string, object> { { "ok", true } };
    }
    static uint Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x2E) || vk == 0xA3 || vk == 0xA5 || vk == 0x5B || vk == 0x5C ? 0x0001u : 0u; } // arrows, home/end, insert/delete, right ctrl/alt, win

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
    [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
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
