// Native helper for the Windows hand. Built on first use by win/desktop.ts with
// the C# 5 compiler that ships in Windows (.NET Framework csc.exe), so keep
// this file to C# 5: no string interpolation, no expression bodies.
//
//   puk-win mic            raw PCM (24 kHz, mono, s16le) on stdout until stdin closes
//   puk-win hotkey <vk>    prints "down" / "up" for the held key, "cancel" for Ctrl+Alt+Esc
//   puk-win serve          one reply line per stdin line:
//                            state [desktop[|hwnd:pid:nonce,...]]  JSON windows + retired_window_ids; only verified strays reclaimed
//                            shot <maxWidth>      base64 PNG of the visible screen
//                            grab <hwnd>          base64 PNG of one window, on any desktop; "error blank" if it would not draw
//                            ensure <desktop>     create the named virtual desktop if missing
//                            move <hwnd> <desktop>, show <desktop>, back, remove <desktop>
//                            goto <desktop>       switch without remembering where the user was
//                            raise <hwnd>, close <hwnd>, place <hwnd> <x> <y> <w> <h>
//                            boost <pid>          opt a process tree out of Windows power throttling
//                            viewport <hwnd>      [x,y,w,h] of a Chromium window's page area, in window pixels
//                            http <url>           GET on Windows loopback (WSL cannot reach it), body on one line
//                            cdp <ws> <id> <json> send one DevTools message, reply with the message answering <id>
//                            fg                   the foreground window handle; focus <hwnd> gives it back
//                            blank <w> <h> <text> base64 PNG placeholder for a hand with no window yet
//   puk-win pip            one always-on-top live preview per hand, shown on every virtual desktop.
//                          stdin: "hand <id> <hwnd|0> <idle|working|review|error|done> <label>"
//                          stdout: "enter <id>" when a preview is clicked
//
// Virtual desktops use win/vendor/VirtualDesktop11-24H2.cs (MIT, Markus Scholtes),
// which wraps the undocumented shell COM interfaces for this Windows build.
//
// Every mode exits when stdin reaches EOF. That is the stop signal because it
// works the same from native Bun and through WSL interop, where signals do not
// reach the Windows process.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Desktop = VirtualDesktop.Desktop;

public static class PukWin
{
    static volatile bool stop;

    static int Main(string[] args)
    {
        // Physical pixels everywhere, matching what Cua captures and clicks.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { try { SetProcessDPIAware(); } catch (Exception) { } }
        string mode = args.Length > 0 ? args[0] : "";
        try
        {
            if (mode == "serve") return Serve();
            if (mode == "pip") return Pip.Run();
            WatchStdin();
            if (mode == "mic") return Mic();
            if (mode == "hotkey") return Hotkey(args.Length > 1 ? int.Parse(args[1]) : 0x77);
            Console.Error.WriteLine("usage: puk-win mic | hotkey <vk> | serve | pip");
            return 2;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }

    static void WatchStdin()
    {
        Thread t = new Thread(delegate ()
        {
            try
            {
                Stream input = Console.OpenStandardInput();
                byte[] buffer = new byte[64];
                while (input.Read(buffer, 0, buffer.Length) > 0) { }
            }
            catch (Exception) { }
            stop = true;
        });
        t.IsBackground = true;
        t.Start();
    }

    // ------------------------------------------------------------ microphone

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag, nChannels;
        public uint nSamplesPerSec, nAvgBytesPerSec;
        public ushort nBlockAlign, wBitsPerSample, cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength, dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags, dwLoops;
        public IntPtr lpNext, reserved;
    }

    const uint WHDR_DONE = 1;

    [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr handle, uint device, ref WAVEFORMATEX format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern int waveInStart(IntPtr handle);
    [DllImport("winmm.dll")] static extern int waveInReset(IntPtr handle);
    [DllImport("winmm.dll")] static extern int waveInClose(IntPtr handle);

    static int Mic()
    {
        WAVEFORMATEX format = new WAVEFORMATEX();
        format.wFormatTag = 1; format.nChannels = 1; format.nSamplesPerSec = 24000;
        format.wBitsPerSample = 16; format.nBlockAlign = 2; format.nAvgBytesPerSec = 48000;
        IntPtr handle;
        // WAVE_MAPPER: the default input device, resampled to our format by Windows.
        int rc = waveInOpen(out handle, 0xFFFFFFFF, ref format, IntPtr.Zero, IntPtr.Zero, 0);
        if (rc != 0) throw new Exception("No usable microphone (waveInOpen " + rc + "). Check Windows microphone privacy settings.");
        const int count = 8, bytes = 2400; // 50 ms each
        uint headerSize = (uint)Marshal.SizeOf(typeof(WAVEHDR));
        IntPtr[] headers = new IntPtr[count];
        for (int i = 0; i < count; i++)
        {
            WAVEHDR header = new WAVEHDR();
            header.lpData = Marshal.AllocHGlobal(bytes);
            header.dwBufferLength = bytes;
            headers[i] = Marshal.AllocHGlobal((int)headerSize);
            Marshal.StructureToPtr(header, headers[i], false);
            waveInPrepareHeader(handle, headers[i], headerSize);
            waveInAddBuffer(handle, headers[i], headerSize);
        }
        waveInStart(handle);
        Stream output = Console.OpenStandardOutput();
        byte[] chunk = new byte[bytes];
        int next = 0;
        try
        {
            while (!stop)
            {
                WAVEHDR header = (WAVEHDR)Marshal.PtrToStructure(headers[next], typeof(WAVEHDR));
                if ((header.dwFlags & WHDR_DONE) == 0) { Thread.Sleep(5); continue; }
                int recorded = (int)header.dwBytesRecorded;
                if (recorded > 0)
                {
                    Marshal.Copy(header.lpData, chunk, 0, recorded);
                    output.Write(chunk, 0, recorded);
                    output.Flush();
                }
                // Buffers complete in the order they were queued.
                waveInUnprepareHeader(handle, headers[next], headerSize);
                header.dwFlags = 0; header.dwBytesRecorded = 0;
                Marshal.StructureToPtr(header, headers[next], false);
                waveInPrepareHeader(handle, headers[next], headerSize);
                waveInAddBuffer(handle, headers[next], headerSize);
                next = (next + 1) % count;
            }
        }
        catch (IOException) { /* reader went away */ }
        waveInReset(handle);
        waveInClose(handle);
        return 0;
    }

    // ---------------------------------------------------------------- hotkey

    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);

    static bool Held(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    static int Hotkey(int vk)
    {
        bool down = false, cancelling = false;
        while (!stop)
        {
            bool now = Held(vk);
            if (now != down) { down = now; Console.Out.WriteLine(down ? "down" : "up"); Console.Out.Flush(); }
            bool cancel = Held(0x11) && Held(0x12) && Held(0x1B); // Ctrl+Alt+Esc
            if (cancel && !cancelling) { Console.Out.WriteLine("cancel"); Console.Out.Flush(); }
            cancelling = cancel;
            Thread.Sleep(15);
        }
        return 0;
    }

    // ----------------------------------------------------------------- state

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetProp(IntPtr hwnd, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetProp(IntPtr hwnd, string name, IntPtr data);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    static string Title(IntPtr hwnd)
    {
        StringBuilder text = new StringBuilder(512);
        GetWindowText(hwnd, text, text.Capacity);
        return text.ToString();
    }

    static string Json(string s)
    {
        StringBuilder b = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < 0x20 || c > 0x7e) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    static Desktop Find(string name)
    {
        for (int i = 0; i < Desktop.Count; i++) if (Desktop.DesktopNameFromIndex(i) == name) return Desktop.FromIndex(i);
        return null;
    }

    static Desktop Need(string name)
    {
        Desktop d = Find(name);
        if (d == null) throw new Exception("No virtual desktop named " + name);
        return d;
    }

    sealed class WindowOwner
    {
        public uint pid;
        public long nonce;
    }
    // Window properties die with the window, unlike HWNDs and process IDs, both
    // of which Windows can reuse. The property name is private to this helper.
    static readonly string ownerProperty = "Puk.Owner." + Guid.NewGuid().ToString("N");
    static readonly Dictionary<string, Dictionary<long, WindowOwner>> owned = new Dictionary<string, Dictionary<long, WindowOwner>>();
    static IntPtr userFocus = IntPtr.Zero;

    static bool SameOwner(IntPtr hwnd, WindowOwner owner)
    {
        uint pid;
        return IsWindow(hwnd) && GetWindowThreadProcessId(hwnd, out pid) != 0
            && pid == owner.pid && owner.nonce > 0 && GetProp(hwnd, ownerProperty).ToInt64() == owner.nonce;
    }

    static WindowOwner MarkOwner(IntPtr hwnd)
    {
        uint pid;
        if (!IsWindow(hwnd) || GetWindowThreadProcessId(hwnd, out pid) == 0 || pid == 0) return null;
        long nonce = GetProp(hwnd, ownerProperty).ToInt64();
        if (nonce == 0)
        {
            do { nonce = BitConverter.ToInt64(Guid.NewGuid().ToByteArray(), 0) & long.MaxValue; } while (nonce == 0);
            if (!SetProp(hwnd, ownerProperty, new IntPtr(nonce))) return null;
        }
        WindowOwner owner = new WindowOwner { pid = pid, nonce = nonce };
        return SameOwner(hwnd, owner) ? owner : null;
    }

    static bool Owned(IntPtr hwnd)
    {
        foreach (Dictionary<long, WindowOwner> set in owned.Values)
        {
            WindowOwner owner;
            if (set.TryGetValue(hwnd.ToInt64(), out owner) && SameOwner(hwnd, owner)) return true;
        }
        return false;
    }

    /** With "<desktop>|<hwnd:pid:nonce,...>": that hand's windows, including a
     *  window-lifetime nonce; retired_window_ids confirms dead/recycled owners.
     *  Activating a window that sits on another virtual desktop makes the shell
     *  reassign it to the current one (Cua's UIA clicks do this), so a hand's
     *  verified strays are moved back before listing. An enumeration omission
     *  alone never retires an owner. */
    static string State(string request)
    {
        string desktopName = request;
        Dictionary<long, WindowOwner> mine = null;
        if (request != null && request.IndexOf('|') >= 0)
        {
            desktopName = request.Substring(0, request.IndexOf('|'));
            mine = new Dictionary<long, WindowOwner>();
            foreach (string entry in request.Substring(request.IndexOf('|') + 1).Split(','))
            {
                if (entry.Length == 0) continue;
                string[] parts = entry.Split(':');
                long id, nonce;
                uint pid;
                if (parts.Length != 3 || !long.TryParse(parts[0], out id) || id <= 0
                    || !uint.TryParse(parts[1], out pid) || pid == 0 || parts[2].Length != 16
                    || !long.TryParse(parts[2], System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out nonce) || nonce <= 0)
                    throw new Exception("Window ownership requires HWND, PID and a window-lifetime nonce.");
                mine[id] = new WindowOwner { pid = pid, nonce = nonce };
            }
            owned[desktopName] = mine;
        }
        Desktop desktop = desktopName == null ? null : Need(desktopName);
        if (desktop != null && mine == null)
        {
            if (!owned.TryGetValue(desktopName, out mine)) mine = new Dictionary<long, WindowOwner>();
            owned[desktopName] = mine;
        }
        HashSet<long> retired = new HashSet<long>();
        IntPtr active = GetForegroundWindow();
        if (desktop != null)
        {
            foreach (KeyValuePair<long, WindowOwner> entry in new List<KeyValuePair<long, WindowOwner>>(mine))
            {
                IntPtr hwnd = new IntPtr(entry.Key);
                if (!SameOwner(hwnd, entry.Value)) { retired.Add(entry.Key); mine.Remove(entry.Key); continue; }
                try
                {
                    if (desktop.HasWindow(hwnd)) continue;
                    // HasWindow calls into the shell. Verify again immediately
                    // before moving; a reused handle must never be reclaimed.
                    if (!SameOwner(hwnd, entry.Value)) { retired.Add(entry.Key); mine.Remove(entry.Key); continue; }
                    desktop.MoveWindow(hwnd);
                    if (hwnd == active && SameOwner(hwnd, entry.Value)) Focus(userFocus);
                }
                catch (Exception)
                {
                    // A transient shell failure leaves ownership intact only
                    // while Win32 still verifies the same living window.
                    if (!SameOwner(hwnd, entry.Value)) { retired.Add(entry.Key); mine.Remove(entry.Key); }
                }
            }
        }
        active = GetForegroundWindow();
        if (active != IntPtr.Zero && !Owned(active)) userFocus = active;

        IntPtr foreground = desktop == null ? active : IntPtr.Zero;
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate (IntPtr hwnd, IntPtr l)
        {
            if (desktop == null && hwnd == foreground) { found.Add(hwnd); return true; }
            if (!IsWindowVisible(hwnd) || Title(hwnd).Length == 0) return true;
            if ((GetWindowLongPtr(hwnd, -20).ToInt64() & 0x80) != 0) return true; // WS_EX_TOOLWINDOW
            if (desktop != null)
            {
                long id = hwnd.ToInt64();
                if (retired.Contains(id)) return true;
                try { if (!desktop.HasWindow(hwnd) || Desktop.IsWindowPinned(hwnd)) return true; } catch (Exception) { return true; }
                WindowOwner owner;
                if (mine.TryGetValue(id, out owner))
                {
                    if (!SameOwner(hwnd, owner)) { retired.Add(id); mine.Remove(id); return true; }
                }
                else
                {
                    // Another hand may be reclaiming this very window. Do not
                    // make one live window belong to two hands.
                    foreach (KeyValuePair<string, Dictionary<long, WindowOwner>> hand in owned)
                    {
                        WindowOwner other;
                        if (hand.Key != desktopName && hand.Value.TryGetValue(id, out other) && SameOwner(hwnd, other)) return true;
                    }
                    owner = MarkOwner(hwnd);
                    if (owner == null) return true;
                    // It was not owned before, so enrol only while it is still
                    // on this hand. Unverified off-desktop windows are not moved.
                    try { if (!desktop.HasWindow(hwnd) || Desktop.IsWindowPinned(hwnd)) return true; } catch (Exception) { return true; }
                    if (!SameOwner(hwnd, owner)) return true;
                    mine[id] = owner;
                }
                if (foreground == IntPtr.Zero) foreground = hwnd;
                found.Add(hwnd);
                return true;
            }
            int cloaked = 0;
            DwmGetWindowAttribute(hwnd, 14, out cloaked, 4); // other virtual desktops, suspended UWP
            if (cloaked != 0) return true;
            found.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        StringBuilder b = new StringBuilder();
        b.Append("{\"width\":").Append(GetSystemMetrics(0)).Append(",\"height\":").Append(GetSystemMetrics(1)).Append(",\"windows\":[");
        bool first = true;
        foreach (IntPtr hwnd in found)
        {
            WindowOwner owner = null;
            if (desktop != null && (!mine.TryGetValue(hwnd.ToInt64(), out owner) || !SameOwner(hwnd, owner)))
            {
                retired.Add(hwnd.ToInt64()); mine.Remove(hwnd.ToInt64()); continue;
            }
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            string app = "";
            try { app = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
            string title = Title(hwnd);
            RECT r = Frame(hwnd);
            bool iconic = IsIconic(hwnd);
            if (owner != null && !SameOwner(hwnd, owner)) { retired.Add(hwnd.ToInt64()); mine.Remove(hwnd.ToInt64()); continue; }
            if (!first) b.Append(',');
            first = false;
            b.Append("{\"app\":").Append(Json(app)).Append(",\"title\":").Append(Json(title))
             .Append(",\"focused\":").Append(hwnd == foreground ? "true" : "false")
             .Append(",\"pid\":").Append(pid).Append(",\"containerId\":").Append(hwnd.ToInt64());
            if (owner != null) b.Append(",\"ownerNonce\":").Append(Json(owner.nonce.ToString("x16")));
            b.Append(",\"iconic\":").Append(iconic ? "true" : "false");
            b.Append(",\"rect\":[").Append(r.left).Append(',').Append(r.top).Append(',').Append(r.right - r.left).Append(',').Append(r.bottom - r.top).Append("]}");
        }
        b.Append("],\"retired_window_ids\":[");
        first = true;
        foreach (long id in retired) { if (!first) b.Append(','); first = false; b.Append(id); }
        return b.Append("]}").ToString();
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int left, top, right, bottom; }
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    /** The visible frame, without the invisible resize border GetWindowRect includes. */
    static RECT Frame(IntPtr hwnd)
    {
        RECT r;
        if (DwmGetWindowAttribute(hwnd, 9, out r, 16) != 0) GetWindowRect(hwnd, out r);
        return r;
    }

    /** Windows only lets the process that received the last input change the
     *  foreground window. A bare Alt tap counts as that input. */
    static void Focus(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || GetForegroundWindow() == hwnd) return;
        if (!SetForegroundWindow(hwnd))
        {
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            SetForegroundWindow(hwnd);
        }
    }

    static string Blank(int width, int height, string text)
    {
        using (Bitmap image = new Bitmap(width, height))
        {
            using (Graphics g = Graphics.FromImage(image))
            {
                g.Clear(Color.FromArgb(26, 27, 38));
                using (Font font = new Font("Segoe UI", 20))
                using (StringFormat center = new StringFormat())
                {
                    center.Alignment = StringAlignment.Center; center.LineAlignment = StringAlignment.Center;
                    g.DrawString(text, font, Brushes.Gainsboro, new RectangleF(0, 0, width, height), center);
                }
            }
            using (MemoryStream png = new MemoryStream())
            {
                image.Save(png, ImageFormat.Png);
                return Convert.ToBase64String(png.ToArray());
            }
        }
    }

    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);

    /** PNG of one window's visible frame, wherever it is. PrintWindow asks the
     *  window to render itself, so it works on another virtual desktop; with
     *  PW_RENDERFULLCONTENT it includes GPU-composed content (browsers, XAML).
     *  About four times quicker than a round trip through the driver. */
    static string Grab(IntPtr hwnd)
    {
        RECT outer, frame = Frame(hwnd);
        GetWindowRect(hwnd, out outer);
        int w = outer.right - outer.left, h = outer.bottom - outer.top;
        if (w <= 0 || h <= 0 || IsIconic(hwnd)) throw new Exception("blank");
        using (Bitmap whole = new Bitmap(w, h, PixelFormat.Format32bppRgb))
        {
            using (Graphics g = Graphics.FromImage(whole))
            {
                IntPtr dc = g.GetHdc();
                bool ok = PrintWindow(hwnd, dc, 2);
                g.ReleaseHdc(dc);
                if (!ok) throw new Exception("blank");
            }
            // GetWindowRect includes the invisible resize border; the hand works in the visible frame.
            Rectangle visible = Rectangle.Intersect(new Rectangle(frame.left - outer.left, frame.top - outer.top, frame.right - frame.left, frame.bottom - frame.top), new Rectangle(0, 0, w, h));
            using (Bitmap cut = whole.Clone(visible, PixelFormat.Format24bppRgb))
            {
                // A window that refused to draw comes back one flat colour.
                // The grid reaches into the title bar and toolbar, so a blank white page is not mistaken for it.
                int first = cut.GetPixel(4, 4).ToArgb();
                bool flat = true;
                for (int row = 0; row < 24 && flat; row++)
                    for (int col = 0; col < 24 && flat; col++)
                        flat = cut.GetPixel(4 + (cut.Width - 8) * col / 23, 4 + (cut.Height - 8) * row / 23).ToArgb() == first;
                if (flat) throw new Exception("blank");
                using (MemoryStream png = new MemoryStream())
                {
                    cut.Save(png, ImageFormat.Png);
                    return Convert.ToBase64String(png.ToArray());
                }
            }
        }
    }

    static string Shot(int maxWidth)
    {
        int width = GetSystemMetrics(0), height = GetSystemMetrics(1);
        using (Bitmap full = new Bitmap(width, height))
        {
            using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(0, 0, 0, 0, full.Size);
            int w = Math.Min(width, Math.Max(64, maxWidth)), h = Math.Max(1, height * w / width);
            using (Bitmap small = new Bitmap(w, h))
            {
                using (Graphics g = Graphics.FromImage(small))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    g.DrawImage(full, 0, 0, w, h);
                }
                using (MemoryStream png = new MemoryStream())
                {
                    small.Save(png, ImageFormat.Png);
                    return Convert.ToBase64String(png.ToArray());
                }
            }
        }
    }

    // ------------------------------------------------------------- devtools

    delegate bool EnumChildProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumChildProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);

    static string Viewport(IntPtr window)
    {
        RECT frame = Frame(window), page = new RECT();
        bool found = false;
        EnumChildWindows(window, delegate (IntPtr child, IntPtr l)
        {
            StringBuilder name = new StringBuilder(64);
            GetClassName(child, name, name.Capacity);
            if (name.ToString() != "Chrome_RenderWidgetHostHWND" || !IsWindowVisible(child)) return true;
            GetWindowRect(child, out page);
            found = true;
            return false;
        }, IntPtr.Zero);
        if (!found) throw new Exception("No page area in this window.");
        return "[" + (page.left - frame.left) + "," + (page.top - frame.top) + "," + (page.right - page.left) + "," + (page.bottom - page.top) + "]";
    }

    static string Http(string url)
    {
        if (!url.StartsWith("http://127.0.0.1:")) throw new Exception("Loopback only.");
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
        request.Timeout = 4000; request.Proxy = null;
        using (WebResponse response = request.GetResponse())
        using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            return reader.ReadToEnd().Replace("\r", "").Replace("\n", " ");
    }

    static readonly Dictionary<string, ClientWebSocket> sockets = new Dictionary<string, ClientWebSocket>();

    /** A relay, not a client: the JSON is composed and read in TypeScript. */
    static string Cdp(string url, string id, string message)
    {
        if (!url.StartsWith("ws://127.0.0.1:")) throw new Exception("Loopback only.");
        // A call into a page that is navigating away may never be answered. Give up soon:
        // this process answers one request at a time.
        CancellationTokenSource timeout = new CancellationTokenSource(2500);
        ClientWebSocket socket;
        if (!sockets.TryGetValue(url, out socket) || socket.State != WebSocketState.Open)
        {
            socket = new ClientWebSocket();
            socket.ConnectAsync(new Uri(url), timeout.Token).Wait();
            sockets[url] = socket;
        }
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes(message);
            socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, timeout.Token).Wait();
            byte[] buffer = new byte[65536];
            string prefix = "{\"id\":" + id + ",";
            for (;;)
            {
                MemoryStream whole = new MemoryStream();
                WebSocketReceiveResult part;
                do
                {
                    part = socket.ReceiveAsync(new ArraySegment<byte>(buffer), timeout.Token).Result;
                    if (part.MessageType == WebSocketMessageType.Close) throw new Exception("The page closed.");
                    whole.Write(buffer, 0, part.Count);
                } while (!part.EndOfMessage);
                string text = Encoding.UTF8.GetString(whole.ToArray());
                if (text.StartsWith(prefix)) return text.Replace("\n", " "); // everything else is an event
            }
        }
        catch (Exception) { sockets.Remove(url); try { socket.Dispose(); } catch (Exception) { } throw; }
    }

    // ---------------------------------------------------------- power throttling

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESSENTRY32
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct POWER_THROTTLING { public uint Version, ControlMask, StateMask; }
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool SetProcessInformation(IntPtr process, int infoClass, ref POWER_THROTTLING info, uint size);
    [DllImport("kernel32.dll")] static extern bool SetPriorityClass(IntPtr process, uint priority);

    /** Windows slows processes that have no visible window, hardest on battery. A
     *  hand's apps never have one, so they are opted out: the process and all it
     *  started (a browser's renderers and GPU process). Returns how many. */
    static int Boost(uint root)
    {
        Dictionary<uint, List<uint>> children = new Dictionary<uint, List<uint>>();
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        PROCESSENTRY32 entry = new PROCESSENTRY32();
        entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
        if (Process32First(snapshot, ref entry))
        {
            do
            {
                List<uint> list;
                if (!children.TryGetValue(entry.th32ParentProcessID, out list)) children[entry.th32ParentProcessID] = list = new List<uint>();
                list.Add(entry.th32ProcessID);
            } while (Process32Next(snapshot, ref entry));
        }
        CloseHandle(snapshot);
        Queue<uint> todo = new Queue<uint>();
        HashSet<uint> seen = new HashSet<uint>();
        todo.Enqueue(root);
        int done = 0;
        while (todo.Count > 0)
        {
            uint pid = todo.Dequeue();
            if (!seen.Add(pid)) continue;
            List<uint> more;
            if (children.TryGetValue(pid, out more)) foreach (uint child in more) todo.Enqueue(child);
            IntPtr process = OpenProcess(0x0200, false, pid); // PROCESS_SET_INFORMATION
            if (process == IntPtr.Zero) continue;
            POWER_THROTTLING off = new POWER_THROTTLING();
            off.Version = 1; off.ControlMask = 1; off.StateMask = 0; // execution speed: never throttle
            if (SetProcessInformation(process, 4, ref off, (uint)Marshal.SizeOf(typeof(POWER_THROTTLING)))) done++;
            SetPriorityClass(process, 0x20); // NORMAL, in case it was dropped to idle
            CloseHandle(process);
        }
        return done;
    }

    static int home = -1;
    static IntPtr homeFocus = IntPtr.Zero;

    static int Serve()
    {
        // Typed text and page titles are not ASCII; the console default is the system code page.
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            string reply;
            try
            {
                string[] words = line.Split(new char[] { ' ' }, 3);
                string rest = line.IndexOf(' ') < 0 ? null : line.Substring(line.IndexOf(' ') + 1);
                if (words[0] == "state") reply = State(rest);
                else if (words[0] == "ensure")
                {
                    if (Find(rest) == null) Desktop.Create().SetName(rest);
                    reply = "ok " + Desktop.FromDesktop(Need(rest));
                }
                else if (words[0] == "move") { Need(words[2]).MoveWindow(new IntPtr(long.Parse(words[1]))); reply = "ok"; }
                else if (words[0] == "grab") reply = Grab(new IntPtr(long.Parse(words[1])));
                else if (words[0] == "boost") reply = "ok " + Boost(uint.Parse(words[1]));
                else if (words[0] == "viewport") reply = Viewport(new IntPtr(long.Parse(words[1])));
                else if (words[0] == "http") reply = Http(rest);
                else if (words[0] == "cdp")
                {
                    string[] parts = line.Split(new char[] { ' ' }, 4);
                    reply = Cdp(parts[1], parts[2], parts[3]);
                }
                else if (words[0] == "fg") reply = GetForegroundWindow().ToInt64().ToString();
                else if (words[0] == "focus") { Focus(new IntPtr(long.Parse(words[1]))); reply = "ok"; }
                else if (words[0] == "blank")
                {
                    string[] parts = line.Split(new char[] { ' ' }, 4);
                    reply = Blank(int.Parse(parts[1]), int.Parse(parts[2]), parts.Length > 3 ? parts[3] : "");
                }
                else if (words[0] == "show")
                {
                    Desktop target = Need(rest);
                    if (Desktop.FromDesktop(Desktop.Current) != Desktop.FromDesktop(target))
                    {
                        // A second hand may borrow the screen before the first has given it back.
                        if (home < 0) { home = Desktop.FromDesktop(Desktop.Current); homeFocus = GetForegroundWindow(); }
                        target.MakeVisible();
                    }
                    reply = "ok";
                }
                else if (words[0] == "back")
                {
                    if (home >= 0 && home < Desktop.Count) { Desktop.FromIndex(home).MakeVisible(); Thread.Sleep(120); Focus(homeFocus); }
                    home = -1;
                    reply = "ok";
                }
                else if (words[0] == "goto") { Need(rest).MakeVisible(); reply = "ok"; }
                else if (words[0] == "close")
                {
                    // Ask the window, never kill the process: one process can host many
                    // apps' windows (ApplicationFrameHost holds Calculator, Settings, Sticky Notes).
                    PostMessage(new IntPtr(long.Parse(words[1])), 0x0010, IntPtr.Zero, IntPtr.Zero);
                    reply = "ok";
                }
                else if (words[0] == "raise")
                {
                    // Front of its own desktop's stack, without activating it or switching desktops.
                    SetWindowPos(new IntPtr(long.Parse(words[1])), IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
                    reply = "ok";
                }
                else if (words[0] == "place")
                {
                    string[] n = line.Split(' ');
                    IntPtr hwnd = new IntPtr(long.Parse(n[1]));
                    ShowWindow(hwnd, 4); // SW_SHOWNOACTIVATE also leaves the maximized state
                    SetWindowPos(hwnd, IntPtr.Zero, int.Parse(n[2]), int.Parse(n[3]), int.Parse(n[4]), int.Parse(n[5]), 0x0004 | 0x0010);
                    reply = "ok";
                }
                else if (words[0] == "all")
                {
                    // Diagnostics: every titled top-level window, wherever it is.
                    StringBuilder list = new StringBuilder("[");
                    EnumWindows(delegate (IntPtr hwnd, IntPtr l)
                    {
                        if (Title(hwnd).Length == 0) return true;
                        uint pid; GetWindowThreadProcessId(hwnd, out pid);
                        if (rest != null && pid.ToString() != rest) return true;
                        int cloaked = 0; DwmGetWindowAttribute(hwnd, 14, out cloaked, 4);
                        string on = "?";
                        try { on = Desktop.DesktopNameFromDesktop(Desktop.FromWindow(hwnd)); } catch (Exception e) { on = "! " + e.Message; }
                        list.Append(list.Length > 1 ? "," : "").Append("{\"hwnd\":").Append(hwnd.ToInt64()).Append(",\"pid\":").Append(pid)
                            .Append(",\"title\":").Append(Json(Title(hwnd))).Append(",\"visible\":").Append(IsWindowVisible(hwnd) ? "true" : "false")
                            .Append(",\"iconic\":").Append(IsIconic(hwnd) ? "true" : "false").Append(",\"cloaked\":").Append(cloaked)
                            .Append(",\"tool\":").Append((GetWindowLongPtr(hwnd, -20).ToInt64() & 0x80) != 0 ? "true" : "false")
                            .Append(",\"desktop\":").Append(Json(on)).Append('}');
                        return true;
                    }, IntPtr.Zero);
                    reply = list.Append(']').ToString();
                }
                else if (words[0] == "where") reply = Json(Desktop.DesktopNameFromIndex(Desktop.FromDesktop(Desktop.Current)));
                else if (words[0] == "remove") { Desktop d = Find(rest); if (d != null) d.Remove(); reply = "ok"; }
                else if (words[0] == "desktops")
                {
                    StringBuilder names = new StringBuilder("[");
                    for (int i = 0; i < Desktop.Count; i++) names.Append(i > 0 ? "," : "").Append(Json(Desktop.DesktopNameFromIndex(i)));
                    reply = names.Append("]").ToString();
                }
                else if (line.StartsWith("shot")) reply = Shot(line.Length > 5 ? int.Parse(line.Substring(5)) : 1280);
                else reply = "error unknown command";
            }
            catch (Exception e)
            {
                while (e.InnerException != null) e = e.InnerException; // unwrap Task and COM wrappers
                reply = "error " + e.Message.Replace('\n', ' ').Replace('\r', ' ');
            }
            Console.Out.WriteLine(reply);
            Console.Out.Flush();
        }
        return 0;
    }
}

// ------------------------------------------------------------------- pip

/** A preview is a borderless always-on-top window holding a live DWM thumbnail
 *  of the hand's front window. DWM composes it on the GPU, so it stays live
 *  while the source sits on another virtual desktop, at no capture cost. */
class PipForm : Form
{
    [StructLayout(LayoutKind.Sequential)]
    struct THUMB
    {
        public int flags;
        public PukWin.RECT destination, source;
        public byte opacity;
        public int visible, clientOnly;
    }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int w, h; }
    [DllImport("dwmapi.dll")] static extern int DwmRegisterThumbnail(IntPtr dest, IntPtr src, out IntPtr thumb);
    [DllImport("dwmapi.dll")] static extern int DwmUnregisterThumbnail(IntPtr thumb);
    [DllImport("dwmapi.dll")] static extern int DwmUpdateThumbnailProperties(IntPtr thumb, ref THUMB props);
    [DllImport("dwmapi.dll")] static extern int DwmQueryThumbnailSourceSize(IntPtr thumb, out SIZE size);

    public readonly int Id;
    IntPtr source = IntPtr.Zero, thumb = IntPtr.Zero;
    readonly Label caption = new Label();
    readonly Label waiting = new Label();
    Point pressed, origin;
    bool dragging, moved;
    const int Border = 3, Header = 22;

    public PipForm(int id, int slot)
    {
        Id = id;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        Size = new Size(area.Width / 5, area.Width / 5 * 10 / 16 + Header);
        Location = new Point(area.Right - Width - 16, area.Bottom - (Height + 12) * (slot + 1));
        BackColor = Color.FromArgb(122, 162, 247);
        caption.SetBounds(Border, Border, Width - 2 * Border, Header - Border);
        caption.ForeColor = Color.White; caption.BackColor = Color.FromArgb(26, 27, 38);
        caption.Font = new Font("Segoe UI", 8.5f);
        caption.TextAlign = ContentAlignment.MiddleLeft;
        Controls.Add(caption);
        Panel body = new Panel();
        body.SetBounds(Border, Header, Width - 2 * Border, Height - Header - Border);
        body.BackColor = Color.FromArgb(26, 27, 38);
        // Shown until the hand has a window to stream, so a starting hand is not a black box.
        waiting.Dock = DockStyle.Fill;
        waiting.ForeColor = Color.FromArgb(120, 130, 170); waiting.Font = new Font("Segoe UI", 9f);
        waiting.TextAlign = ContentAlignment.MiddleCenter;
        body.Controls.Add(waiting);
        Controls.Add(body);
        foreach (Control c in new Control[] { this, caption, body, waiting })
        {
            c.MouseDown += Down; c.MouseMove += Moving; c.MouseUp += Up;
        }
    }

    // Never take focus from whatever the user is typing in.
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get { CreateParams p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80; return p; } // NOACTIVATE | TOOLWINDOW
    }

    void Down(object sender, MouseEventArgs e) { dragging = true; moved = false; pressed = Cursor.Position; origin = Location; }
    void Moving(object sender, MouseEventArgs e)
    {
        if (!dragging) return;
        Point now = Cursor.Position;
        if (Math.Abs(now.X - pressed.X) + Math.Abs(now.Y - pressed.Y) > 5) moved = true;
        if (moved) Location = new Point(origin.X + now.X - pressed.X, origin.Y + now.Y - pressed.Y);
    }
    void Up(object sender, MouseEventArgs e)
    {
        dragging = false;
        if (!moved) { Console.Out.WriteLine("enter " + Id); Console.Out.Flush(); }
    }

    public void Update(IntPtr hwnd, string state, string label)
    {
        caption.Text = "  hand " + Id + "  ·  " + state + (label.Length > 0 ? "  ·  " + label : "");
        BackColor = state == "review" ? Color.FromArgb(224, 175, 104) : state == "error" ? Color.FromArgb(247, 118, 142)
                  : state == "working" ? Color.FromArgb(122, 162, 247) : state == "done" ? Color.FromArgb(158, 206, 106) : Color.FromArgb(65, 72, 104);
        waiting.Text = state == "done" ? "finished" : state == "error" ? "stopped" : "starting\u2026";
        waiting.Visible = hwnd == IntPtr.Zero;
        bool show = state != "idle";
        if (show && !Visible)
        {
            Show();
            try { VirtualDesktop.Desktop.PinWindow(Handle); } catch (Exception) { }
        }
        else if (!show && Visible) Hide();
        if (hwnd != source)
        {
            if (thumb != IntPtr.Zero) { DwmUnregisterThumbnail(thumb); thumb = IntPtr.Zero; }
            source = hwnd;
            if (hwnd != IntPtr.Zero && DwmRegisterThumbnail(Handle, hwnd, out thumb) != 0) { thumb = IntPtr.Zero; source = IntPtr.Zero; }
        }
        if (thumb == IntPtr.Zero) return;
        SIZE size;
        if (DwmQueryThumbnailSourceSize(thumb, out size) != 0 || size.w <= 0 || size.h <= 0) return;
        int w = Width - 2 * Border, h = Height - Header - Border;
        double scale = Math.Min((double)w / size.w, (double)h / size.h);
        int tw = (int)(size.w * scale), th = (int)(size.h * scale);
        THUMB props = new THUMB();
        props.flags = 1 | 4 | 8; // destination, opacity, visible
        props.destination.left = Border + (w - tw) / 2; props.destination.top = Header + (h - th) / 2;
        props.destination.right = props.destination.left + tw; props.destination.bottom = props.destination.top + th;
        props.opacity = 255; props.visible = 1;
        DwmUpdateThumbnailProperties(thumb, ref props);
    }
}

static class Pip
{
    public static int Run()
    {
        Application.EnableVisualStyles();
        Form anchor = new Form();            // owns the UI thread; never shown
        IntPtr unused = anchor.Handle;
        Dictionary<int, PipForm> previews = new Dictionary<int, PipForm>();
        Thread reader = new Thread(delegate ()
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                string[] w = line.Split(new char[] { ' ' }, 5);
                if (w.Length < 4 || w[0] != "hand") continue;
                int id; long hwnd;
                if (!int.TryParse(w[1], out id) || !long.TryParse(w[2], out hwnd)) continue;
                string state = w[3], label = w.Length > 4 ? w[4] : "";
                anchor.BeginInvoke((MethodInvoker)delegate ()
                {
                    PipForm form;
                    if (!previews.TryGetValue(id, out form)) { form = new PipForm(id, previews.Count); previews[id] = form; }
                    form.Update(new IntPtr(hwnd), state, label);
                });
            }
            anchor.BeginInvoke((MethodInvoker)delegate () { Application.Exit(); });
        });
        reader.IsBackground = true;
        reader.Start();
        Application.Run();
        return 0;
    }
}
