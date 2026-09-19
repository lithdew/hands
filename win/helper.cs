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
//   puk-win hud            the caption at the bottom of the screen while the hotkey is held: click-through,
//                          never activated, on every virtual desktop. stdin, one command per line, <text> to end of line:
//                            listening                          show; transcript and rows cleared
//                            transcript <text>                  replace the transcript (the whole partial, not a delta)
//                            finishing                          key released; the final transcript is pending (hides itself after 20 s)
//                            task <id> <status> <hand> <text>   upsert a row: waiting|running|done|failed|cancelled; hand 0 = none yet
//                            progress <hand> <text>             muted caption on that hand's running row
//                            settle | nothing | error <text> | cancelled | hide   hold 2.6 s | 1.4 s | 4 s | 0.9 s | fade now
//                          stdout: nothing. PUK_HUD_TRACE=1 narrates on stderr.
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
            if (mode == "hud") return Hud.Run();   // reads stdin itself, like pip
            WatchStdin();
            if (mode == "mic") return Mic();
            if (mode == "hotkey") return Hotkey(args.Length > 1 ? int.Parse(args[1]) : 0x77);
            Console.Error.WriteLine("usage: puk-win mic | hotkey <vk> | serve | pip | hud");
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
    sealed class BorrowedWindow { public long hwnd; public WindowOwner owner; }
    static readonly Dictionary<string, BorrowedWindow> borrowed = new Dictionary<string, BorrowedWindow>();
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

    static bool Borrowed(IntPtr hwnd)
    {
        foreach (BorrowedWindow entry in borrowed.Values)
            if (entry.hwnd == hwnd.ToInt64() && SameOwner(hwnd, entry.owner)) return true;
        return false;
    }

    // Read-only native observation plus a window-lifetime marker. These windows
    // never enter owned[], and no virtual-desktop API is used to capture them.
    static string ExternalWindow(IntPtr hwnd, WindowOwner owner)
    {
        if (owner == null || !SameOwner(hwnd, owner) || !IsWindowVisible(hwnd)) return "null";
        string app;
        try { app = Process.GetProcessById((int)owner.pid).ProcessName; } catch (Exception) { return "null"; }
        if (!string.Equals(app, "chrome", StringComparison.OrdinalIgnoreCase)) return "null";
        string title = Title(hwnd);
        RECT r = Frame(hwnd);
        if (title.Length == 0 || !SameOwner(hwnd, owner)) return "null";
        return "{\"app\":" + Json(app) + ",\"title\":" + Json(title) + ",\"focused\":true,\"pid\":" + owner.pid
            + ",\"containerId\":" + hwnd.ToInt64() + ",\"ownerNonce\":" + Json(owner.nonce.ToString("x16"))
            + ",\"iconic\":" + (IsIconic(hwnd) ? "true" : "false") + ",\"rect\":[" + r.left + "," + r.top + "," + (r.right - r.left) + "," + (r.bottom - r.top) + "]}";
    }

    static string ExternalBrowsers()
    {
        StringBuilder result = new StringBuilder("[");
        EnumWindows(delegate (IntPtr hwnd, IntPtr unused)
        {
            if (!IsWindowVisible(hwnd) || Title(hwnd).Length == 0 || Owned(hwnd) || (GetWindowLongPtr(hwnd, -20).ToInt64() & 0x80) != 0) return true;
            // A real browser on the user's other virtual desktop is cloaked by
            // DWM but remains an eligible non-owning target. Puk's own windows
            // are excluded by ownership and, in TypeScript, its exact PIDs.
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            try { if (!string.Equals(Process.GetProcessById((int)pid).ProcessName, "chrome", StringComparison.OrdinalIgnoreCase)) return true; }
            catch (Exception) { return true; }
            string window = ExternalWindow(hwnd, MarkOwner(hwnd));
            if (window != "null") result.Append(result.Length > 1 ? "," : "").Append(window);
            return true;
        }, IntPtr.Zero);
        return result.Append(']').ToString();
    }

    static string ExternalBinding(string request, bool claim, bool focus = false)
    {
        int separator = request == null ? -1 : request.IndexOf('|');
        if (separator <= 0) throw new Exception("An existing browser binding needs a hand and its exact native identity.");
        string hand = request.Substring(0, separator);
        string[] parts = request.Substring(separator + 1).Split(':');
        long id, nonce;
        uint pid;
        if (parts.Length != 3 || !long.TryParse(parts[0], out id) || id <= 0 || !uint.TryParse(parts[1], out pid) || pid == 0
            || parts[2].Length != 16 || !long.TryParse(parts[2], System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out nonce) || nonce <= 0)
            throw new Exception("An existing browser binding needs HWND, PID and a window-lifetime nonce.");
        IntPtr hwnd = new IntPtr(id);
        WindowOwner owner = new WindowOwner { pid = pid, nonce = nonce };
        if (claim)
        {
            if (Owned(hwnd) || ExternalWindow(hwnd, owner) == "null") throw new Exception("This is not an available, unowned Chrome window.");
            foreach (KeyValuePair<string, BorrowedWindow> entry in borrowed)
                if (entry.Key != hand && (entry.Value.owner.pid == pid || entry.Value.hwnd == id))
                    throw new Exception("This Chrome process is already reserved by another hand.");
            borrowed[hand] = new BorrowedWindow { hwnd = id, owner = owner };
        }
        BorrowedWindow bound;
        if (!borrowed.TryGetValue(hand, out bound) || bound.hwnd != id || bound.owner.pid != pid || bound.owner.nonce != nonce)
            throw new Exception("The existing Chrome reservation changed. Attach again.");
        string observed = ExternalWindow(hwnd, owner);
        if (focus)
        {
            if (observed == "null") throw new Exception("The attached Chrome window is unavailable.");
            // Visit its real desktop before activation. Never let activation
            // reassign a user's browser to the hand's current virtual desktop.
            Desktop target = Desktop.FromWindow(hwnd);
            if (!SameOwner(hwnd, owner)) throw new Exception("The attached Chrome window changed before focus.");
            target.MakeVisible();
            if (!SameOwner(hwnd, owner)) throw new Exception("The attached Chrome window changed before focus.");
            Focus(hwnd);
        }
        return observed;
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
                if (Borrowed(hwnd)) { retired.Add(entry.Key); mine.Remove(entry.Key); continue; }
                if (!SameOwner(hwnd, entry.Value)) { retired.Add(entry.Key); mine.Remove(entry.Key); continue; }
                try
                {
                    if (desktop.HasWindow(hwnd)) continue;
                    // HasWindow calls into the shell. Verify again immediately
                    // before moving; a reused handle must never be reclaimed.
                    if (!SameOwner(hwnd, entry.Value)) { retired.Add(entry.Key); mine.Remove(entry.Key); continue; }
                    desktop.MoveWindow(hwnd, true);
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
                if (Borrowed(hwnd)) return true;
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
                else if (words[0] == "external-browsers") reply = ExternalBrowsers();
                else if (words[0] == "external-bind") reply = ExternalBinding(rest, true);
                else if (words[0] == "external-read") reply = ExternalBinding(rest, false);
                else if (words[0] == "external-focus") reply = ExternalBinding(rest, false, true);
                else if (words[0] == "external-release") { borrowed.Remove(rest); reply = "ok"; }
                else if (words[0] == "ensure")
                {
                    if (Find(rest) == null) Desktop.Create().SetName(rest);
                    reply = "ok " + Desktop.FromDesktop(Need(rest));
                }
                else if (words[0] == "move")
                {
                    IntPtr hwnd = new IntPtr(long.Parse(words[1]));
                    if (Borrowed(hwnd)) throw new Exception("A borrowed user window cannot be moved to a hand desktop.");
                    Need(words[2]).MoveWindow(hwnd, true); reply = "ok";
                }
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

/** A preview is a borderless, always-on-top, never-activated tool window that
 *  holds a live DWM thumbnail of the hand's front window. DWM composes the
 *  thumbnail on the GPU above everything this form paints, so it stays live
 *  while the source sits on another virtual desktop, at no capture cost.
 *
 *  Everything around the thumbnail is painted by hand in OnPaint:
 *
 *    +-------------------------------------------------------+  <- 2px state ring
 *    | [1] working  Wikipedia - Google Chrome       Switch > |  <- caption chip (hover shows "Switch")
 *    | +---------------------------------------------------+ |
 *    | |                                                   | |
 *    | |              DWM thumbnail (fit, centred)         | |  <- "well": near-black, letterboxes
 *    | |                                                   | |
 *    | +---------------------------------------------------+ |
 *    +-------------------------------------------------------+
 *
 *  The ring colour encodes state (blue working, amber needs approval, red
 *  stopped, green done). Working and review pulse gently so the user can tell
 *  the hand is alive; done and error are still. A hand with no window yet shows
 *  a spinner and "Hand 2 is starting..." instead of a black box.
 *
 *  Because the thumbnail is composed *over* the form, nothing can be drawn on
 *  top of it. Every affordance therefore lives in the chrome (ring + caption).
 */
class PipForm : Form
{
    // ---- DWM thumbnails -------------------------------------------------------
    [StructLayout(LayoutKind.Sequential)]
    struct THUMB
    {
        public int flags;
        public PukWin.RECT destination, source;
        public byte opacity;
        public int visible, clientOnly;
    }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int w, h; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [DllImport("dwmapi.dll")] static extern int DwmRegisterThumbnail(IntPtr dest, IntPtr src, out IntPtr thumb);
    [DllImport("dwmapi.dll")] static extern int DwmUnregisterThumbnail(IntPtr thumb);
    [DllImport("dwmapi.dll")] static extern int DwmUpdateThumbnailProperties(IntPtr thumb, ref THUMB props);
    [DllImport("dwmapi.dll")] static extern int DwmQueryThumbnailSourceSize(IntPtr thumb, out SIZE size);

    // ---- Window chrome ---------------------------------------------------------
    // DWMWA_WINDOW_CORNER_PREFERENCE (33) = DWMWCP_ROUND (2): Windows 11 rounds
    // the corners and clips the thumbnail with them. Fails with E_INVALIDARG on
    // Windows 10, where SetWindowRgn with a round-rect region is the fallback.
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int w, int h);
    [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr hwnd, IntPtr region, bool redraw);
    // Per-monitor DPI without depending on .NET 4.7's Control.DeviceDpi.
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);

    const int WM_MOUSEACTIVATE = 0x0021, WM_DPICHANGED = 0x02E0;
    const int MA_NOACTIVATE = 3;
    const int DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2;
    const int CS_DROPSHADOW = 0x00020000;
    const int WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOOLWINDOW = 0x00000080;

    // Typographic characters as escapes, so the source compiles the same under
    // any code page (helper.cs has no BOM and csc falls back to the system ANSI page).
    static readonly string Dot = ((char)0x00B7).ToString();       // middle dot
    static readonly string Chevron = ((char)0x203A).ToString();   // single right-pointing angle quote
    static readonly string Ellipsis = ((char)0x2026).ToString();  // horizontal ellipsis

    // ---- Palette (Tokyo Night, shared with panel.html) -------------------------
    static readonly Color Chrome = Color.FromArgb(22, 22, 30);      // window slab
    static readonly Color Well = Color.FromArgb(11, 11, 16);        // behind the thumbnail
    static readonly Color Fg = Color.FromArgb(192, 202, 245);       // primary text
    static readonly Color FgMuted = Color.FromArgb(169, 177, 214);  // title text
    static readonly Color FgDim = Color.FromArgb(86, 95, 137);      // separators, hints
    static readonly Color Working = Color.FromArgb(122, 162, 247);
    static readonly Color Review = Color.FromArgb(224, 175, 104);
    static readonly Color Failed = Color.FromArgb(247, 118, 142);
    static readonly Color Done = Color.FromArgb(158, 206, 106);
    static readonly Color Idle = Color.FromArgb(65, 72, 104);

    // ---- State ------------------------------------------------------------------
    public readonly int Id;
    readonly int slot;
    IntPtr source = IntPtr.Zero, thumb = IntPtr.Zero;
    string state = "idle", label = "";
    bool hover, roundedByDwm;
    Point pressed, origin;
    bool dragging, moved;

    // Fade: Opacity is animated between 0 and 1 by the timer. While a fade runs
    // the thumbnail is hidden, because a layered (translucent) window may not
    // compose DWM thumbnails; the chrome fades in first and the picture lands
    // the moment the window is opaque again. Reads as a deliberate reveal.
    bool fading; double fadeFrom, fadeTarget = 1; int fadeStart, fadeDuration = FadeInMs;
    const int FadeInMs = 180, FadeOutMs = 150;

    // Metrics, all in physical pixels, recomputed from DPI in Measure().
    int dpi = 96, Inset, Caption, Radius, Ring, Badge, Pad;
    Rectangle body;                       // where the thumbnail lives
    Font fontText, fontStrong, fontBadge, fontTitle;

    // System.Threading is also imported in helper.cs, so name the WinForms timer in full.
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();   // pulse, spinner, fades; runs only while something moves

    public PipForm(int id, int slot)
    {
        Id = id; this.slot = slot;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Cursor = Cursors.Hand;             // the whole window is a button
        BackColor = Chrome;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);

        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        Measure(DpiAt(new Point(area.Right - 1, area.Bottom - 1)), area.Width);
        Location = Pip.Place(slot, Size, area, Pad * 2, Pad + Pad / 2);

        MouseDown += Down; MouseMove += Moving; MouseUp += Up;
        MouseEnter += delegate (object s, EventArgs e) { hover = true; Invalidate(); };
        MouseLeave += delegate (object s, EventArgs e) { hover = false; Invalidate(); };
        timer.Interval = 33;               // ~30 fps is plenty for a 2px ring
        timer.Tick += Tick;
    }

    // ---- Never take focus ---------------------------------------------------------
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams p = base.CreateParams;
            p.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
            p.ClassStyle |= CS_DROPSHADOW;   // system drop shadow; works on Windows 10 and 11
            return p;
        }
    }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_MOUSEACTIVATE) { m.Result = new IntPtr(MA_NOACTIVATE); return; }
        if (m.Msg == WM_DPICHANGED)
        {
            // Dragged onto a monitor with another scale: adopt its DPI, keep the
            // top-left Windows suggests, and re-measure everything.
            int newDpi = (int)((long)m.WParam & 0xFFFF);
            PukWin.RECT suggested = (PukWin.RECT)Marshal.PtrToStructure(m.LParam, typeof(PukWin.RECT));
            Measure(newDpi, Screen.FromPoint(new Point(suggested.left, suggested.top)).WorkingArea.Width);
            Location = new Point(suggested.left, suggested.top);
            m.Result = IntPtr.Zero;
            return;
        }
        base.WndProc(ref m);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyCorners();
        // A recreated handle silently loses its thumbnail registration.
        thumb = IntPtr.Zero;
        if (source != IntPtr.Zero) Register(source);
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (IsHandleCreated && !roundedByDwm) ApplyCorners();
        PushThumb();
    }

    // OnPaint clears to Chrome itself; letting the base fill BackColor first would only add a flash.
    protected override void OnPaintBackground(PaintEventArgs e) { }

    // ---- Geometry ------------------------------------------------------------------
    /** Physical DPI of the monitor under a point, 96 when the API is missing (Windows 8). */
    static int DpiAt(Point at)
    {
        try
        {
            POINT pt; pt.x = at.X; pt.y = at.Y;
            uint x, y;
            if (GetDpiForMonitor(MonitorFromPoint(pt, 2 /* MONITOR_DEFAULTTONEAREST */), 0 /* MDT_EFFECTIVE_DPI */, out x, out y) == 0 && x > 0) return (int)x;
        }
        catch (Exception) { }
        return 96;
    }

    int R(double logicalPx) { return Math.Max(1, (int)Math.Round(logicalPx * dpi / 96.0)); }

    /** Sizes fonts, paddings and the window itself for a DPI and a screen width. */
    void Measure(int newDpi, int screenWidth)
    {
        dpi = newDpi;
        Inset = R(6); Caption = R(26); Radius = R(10); Ring = R(2); Badge = R(18); Pad = R(8);
        DisposeFonts();
        using (System.Drawing.Text.InstalledFontCollection installed = new System.Drawing.Text.InstalledFontCollection())
        {
            // 13px, not 12: in a 26px chip on a 1366x768 laptop at 100%, 12px Segoe UI is at the legibility floor.
            fontText = Pick(installed, R(13), FontStyle.Regular, "Segoe UI Variable Text", "Segoe UI");
            fontStrong = Pick(installed, R(13), FontStyle.Bold, "Segoe UI Variable Text Semibold", "Segoe UI Semibold", "Segoe UI");
            fontBadge = Pick(installed, R(10), FontStyle.Bold, "Segoe UI Variable Text Semibold", "Segoe UI Semibold", "Segoe UI");
            fontTitle = Pick(installed, R(14), FontStyle.Bold, "Segoe UI Variable Display Semibold", "Segoe UI Semibold", "Segoe UI");
        }
        // A fifth of the screen, but never so narrow that the caption cannot hold
        // a title, nor so wide that four of them cover a laptop screen.
        int w = Math.Max(R(300), Math.Min(R(480), screenWidth / 5));
        int inner = w - 2 * Inset;
        int h = Inset + Caption + inner * 10 / 16 + Inset;   // 16:10 well under a caption
        // body before Size: the Size setter fires OnResize -> PushThumb(), which must
        // already see the new rectangle or the picture sits in the old one after WM_DPICHANGED.
        body = new Rectangle(Inset, Inset + Caption, inner, h - 2 * Inset - Caption);
        Size = new Size(w, h);
        Invalidate();
    }

    /** First installed family from the list, else the generic sans. Weight names
     *  ("... Semibold") are separate GDI families, so the plain fallback gets Bold. */
    static Font Pick(System.Drawing.Text.InstalledFontCollection installed, int px, FontStyle style, params string[] families)
    {
        foreach (string wanted in families)
        {
            foreach (FontFamily f in installed.Families)
            {
                if (!SameFamily(f.Name, wanted)) continue;
                // A dedicated weight family is already heavy: ask for Regular so GDI does not fake-bold it.
                FontStyle s = wanted.EndsWith("Semibold") ? FontStyle.Regular : style;
                if (!f.IsStyleAvailable(s)) s = FontStyle.Regular;
                return new Font(f, px, s, GraphicsUnit.Pixel);
            }
        }
        return new Font(FontFamily.GenericSansSerif, px, style, GraphicsUnit.Pixel);
    }

    /** GDI reports family names truncated to 31 chars (LF_FACESIZE - 1), so
     *  "Segoe UI Variable Display Semibold" (34) never compares equal. A name that
     *  fills the limit may be the cut form of the other, in either direction; a
     *  shorter one may not, so "Segoe UI" still never matches "Segoe UI Black". */
    static bool SameFamily(string installed, string wanted)
    {
        if (installed == wanted) return true;
        string shorter = installed.Length < wanted.Length ? installed : wanted;
        string longer = installed.Length < wanted.Length ? wanted : installed;
        return shorter.Length >= 31 && longer.StartsWith(shorter);
    }

    void DisposeFonts()
    {
        foreach (Font f in new Font[] { fontText, fontStrong, fontBadge, fontTitle }) if (f != null) f.Dispose();
    }

    /** Windows 11: ask DWM for round corners (it clips the thumbnail too).
     *  Windows 10: clip the window to a round-rect region ourselves. */
    void ApplyCorners()
    {
        int pref = DWMWCP_ROUND;
        roundedByDwm = DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, 4) == 0;
        if (roundedByDwm) { SetWindowRgn(Handle, IntPtr.Zero, true); return; }
        // The system owns the region after SetWindowRgn; do not delete it.
        SetWindowRgn(Handle, CreateRoundRectRgn(0, 0, Width + 1, Height + 1, Radius * 2, Radius * 2), true);
    }

    static GraphicsPath Rounded(Rectangle r, int radius)
    {
        GraphicsPath p = new GraphicsPath();
        int d = Math.Max(1, radius * 2);
        p.AddArc(r.Left, r.Top, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Top, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    // ---- Input ----------------------------------------------------------------------
    void Down(object sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        dragging = true; moved = false; pressed = Cursor.Position; origin = Location;
    }
    void Moving(object sender, MouseEventArgs e)
    {
        if (!dragging) return;
        Point now = Cursor.Position;
        if (Math.Abs(now.X - pressed.X) + Math.Abs(now.Y - pressed.Y) > R(5)) moved = true;
        if (moved) Location = new Point(origin.X + now.X - pressed.X, origin.Y + now.Y - pressed.Y);
    }
    void Up(object sender, MouseEventArgs e)
    {
        if (!dragging || e.Button != MouseButtons.Left) return;
        dragging = false;
        if (!moved) { Console.Out.WriteLine("enter " + Id); Console.Out.Flush(); }
    }

    // ---- Protocol -------------------------------------------------------------------
    /** One stdin line arrived for this hand. Called on the UI thread. */
    public void Apply(IntPtr hwnd, string newState, string newLabel)
    {
        state = newState; label = newLabel ?? "";
        bool want = state != "idle";
        if (want && !Visible)
        {
            Opacity = 0;
            Show();
            try { VirtualDesktop.Desktop.PinWindow(Handle); } catch (Exception) { }   // on every virtual desktop
            FadeTo(1, FadeInMs);
        }
        else if (want && fading && fadeTarget < 0.5) FadeTo(1, FadeInMs);            // came back while hiding
        else if (!want && Visible && !(fading && fadeTarget < 0.5)) FadeTo(0, FadeOutMs);

        if (hwnd != source)
        {
            if (thumb != IntPtr.Zero) { DwmUnregisterThumbnail(thumb); thumb = IntPtr.Zero; }
            source = hwnd;
            if (hwnd != IntPtr.Zero) Register(hwnd);
        }
        PushThumb();
        Wake();
        Invalidate();
    }

    void Register(IntPtr hwnd)
    {
        if (DwmRegisterThumbnail(Handle, hwnd, out thumb) != 0) { thumb = IntPtr.Zero; source = IntPtr.Zero; }
    }

    /** Fit the thumbnail inside the well, centred, hidden while the window fades. */
    void PushThumb()
    {
        if (thumb == IntPtr.Zero) return;
        SIZE size;
        if (DwmQueryThumbnailSourceSize(thumb, out size) != 0 || size.w <= 0 || size.h <= 0) return;
        double scale = Math.Min((double)body.Width / size.w, (double)body.Height / size.h);
        int tw = Math.Max(1, (int)(size.w * scale)), th = Math.Max(1, (int)(size.h * scale));
        THUMB props = new THUMB();
        props.flags = 1 | 4 | 8; // DWM_TNP_RECTDESTINATION | DWM_TNP_OPACITY | DWM_TNP_VISIBLE
        props.destination.left = body.Left + (body.Width - tw) / 2;
        props.destination.top = body.Top + (body.Height - th) / 2;
        props.destination.right = props.destination.left + tw;
        props.destination.bottom = props.destination.top + th;
        props.opacity = 255;
        props.visible = Visible && !fading ? 1 : 0;
        DwmUpdateThumbnailProperties(thumb, ref props);
    }

    // ---- Animation ---------------------------------------------------------------------
    void FadeTo(double target, int ms)
    {
        fading = true; fadeFrom = Opacity; fadeTarget = target; fadeStart = Environment.TickCount; fadeDuration = ms;
        PushThumb();   // hide the picture for the duration
        Wake();
    }

    /** Milliseconds since boot as a phase source; unsigned so the modulo stays
     *  positive after TickCount wraps negative (~25 days of uptime). */
    static uint Now() { return unchecked((uint)Environment.TickCount); }

    /** Something on screen is moving: a fade, a breathing ring, or the spinner of a
     *  hand still waiting for its window. Done and stopped are still even without one. */
    bool Animating()
    {
        return fading || (Visible && (state == "working" || state == "review" || (thumb == IntPtr.Zero && state != "done" && state != "error")));
    }

    void Wake() { if (Animating() && !timer.Enabled) timer.Start(); }

    void Tick(object sender, EventArgs e)
    {
        if (fading)
        {
            double p = Math.Min(1.0, (Environment.TickCount - fadeStart) / (double)fadeDuration);   // int difference survives the wrap
            double eased = 1 - Math.Pow(1 - p, 3);   // ease-out cubic
            Opacity = fadeFrom + (fadeTarget - fadeFrom) * eased;
            if (p >= 1)
            {
                fading = false;
                Opacity = fadeTarget;   // exactly 1.0 drops WS_EX_LAYERED again
                if (fadeTarget < 0.5) Hide();
                PushThumb();            // picture appears the moment we are opaque
            }
        }
        if (Visible) Invalidate();
        if (!Animating()) timer.Stop();
    }

    /** 0..1 breathing curve for the ring: fast while working, slow while waiting on the user. */
    double Pulse()
    {
        double period = state == "working" ? 1.6 : state == "review" ? 2.6 : 0;
        if (period == 0) return 1;
        double t = (Now() % 100000u) / 1000.0;
        return 0.5 + 0.5 * Math.Sin(t * 2 * Math.PI / period);
    }

    // ---- Painting -----------------------------------------------------------------------
    Color StateColor()
    {
        return state == "review" ? Review : state == "error" ? Failed : state == "working" ? Working : state == "done" ? Done : Idle;
    }

    static string StateWord(string s)
    {
        return s == "review" ? "needs approval" : s == "error" ? "stopped" : s == "working" ? "working" : s == "done" ? "done" : "idle";
    }

    static Color Alpha(Color c, int a) { return Color.FromArgb(Math.Max(0, Math.Min(255, a)), c); }
    static Color Lighten(Color c, double k)
    {
        return Color.FromArgb(c.A, (int)(c.R + (255 - c.R) * k), (int)(c.G + (255 - c.G) * k), (int)(c.B + (255 - c.B) * k));
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Chrome);
        using (GraphicsPath well = Rounded(body, R(4)))
        using (SolidBrush b = new SolidBrush(Well)) g.FillPath(b, well);
        DrawCaption(g);
        if (thumb == IntPtr.Zero) DrawEmpty(g);
        DrawRing(g);
    }

    /** 2px state ring at the edge with a soft glow bleeding inwards. Hover brightens it. */
    void DrawRing(Graphics g)
    {
        Color c = StateColor();
        if (hover) c = Lighten(c, 0.25);
        double m = 0.55 + 0.45 * Pulse();          // never fully dark: the ring is the state
        double glow = (hover ? 1.6 : 1.0) * m;
        int[] alphas = new int[] { 70, 34, 14 };
        for (int i = alphas.Length; i >= 1; i--)
        {
            int inset = Ring / 2 + Ring * i;
            Rectangle r = new Rectangle(inset, inset, Width - 1 - 2 * inset, Height - 1 - 2 * inset);
            using (GraphicsPath p = Rounded(r, Math.Max(2, Radius - inset)))
            using (Pen pen = new Pen(Alpha(c, (int)(alphas[i - 1] * glow)), Ring)) g.DrawPath(pen, p);
        }
        Rectangle ring = new Rectangle(Ring / 2, Ring / 2, Width - Ring, Height - Ring);
        using (GraphicsPath p = Rounded(ring, Radius))
        using (Pen pen = new Pen(Alpha(c, (int)(255 * m)), Ring)) g.DrawPath(pen, p);
    }

    /** [n] state-word  label...                      Switch >  */
    void DrawCaption(Graphics g)
    {
        Color c = StateColor();
        TextFormatFlags flags = TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix;
        int cy = Inset + Caption / 2;
        int x = body.Left + Pad / 2;
        int right = body.Right - Pad / 2;

        // Hand number badge: a filled state-coloured square with the number cut into it.
        Rectangle badge = new Rectangle(x, cy - Badge / 2, Badge, Badge);
        using (GraphicsPath p = Rounded(badge, R(5)))
        using (SolidBrush b = new SolidBrush(c)) g.FillPath(b, p);
        TextRenderer.DrawText(g, Id.ToString(), fontBadge, badge, Chrome, flags | TextFormatFlags.HorizontalCenter);
        x += Badge + Pad;

        // State word in the state colour.
        string word = StateWord(state);
        Size ws = TextRenderer.MeasureText(g, word, fontStrong, new Size(int.MaxValue, Caption), flags);
        TextRenderer.DrawText(g, word, fontStrong, new Rectangle(x, Inset, ws.Width + 1, Caption), c, flags);
        x += ws.Width + Pad;

        // Click affordance on the right. Its width is reserved whether or not the
        // cursor is here, so the label does not re-ellipsize and jump on hover.
        // "Switch", not "Open": serve.ts enter() toggles back when already inside.
        string hint = "Switch " + Chevron;
        Size hs = TextRenderer.MeasureText(g, hint, fontStrong, new Size(int.MaxValue, Caption), flags);
        if (hover) TextRenderer.DrawText(g, hint, fontStrong, new Rectangle(right - hs.Width, Inset, hs.Width + 1, Caption), c, flags);
        right -= hs.Width + Pad;

        // Label: serve.ts may send "task <middle dot> window title"; the part after the
        // dot is dimmer. The wire inserts exactly one " <dot> " and strips U+00B7 from
        // the title half before joining, so the first occurrence is the seam.
        if (label.Length == 0 || right - x <= R(24)) return;
        string primary = label, secondary = null;
        int cut = label.IndexOf(" " + Dot + " ");
        if (cut > 0) { primary = label.Substring(0, cut); secondary = label.Substring(cut + 3); }

        Size dot = TextRenderer.MeasureText(g, Dot, fontText, new Size(int.MaxValue, Caption), flags);
        TextRenderer.DrawText(g, Dot, fontText, new Rectangle(x, Inset, dot.Width + 1, Caption), FgDim, flags);
        x += dot.Width + Pad / 2 + Pad / 4;

        Size ps = TextRenderer.MeasureText(g, primary, fontText, new Size(int.MaxValue, Caption), flags);
        int avail = right - x;
        int pw = Math.Min(ps.Width + 1, avail);
        TextRenderer.DrawText(g, primary, fontText, new Rectangle(x, Inset, pw, Caption), FgMuted, flags | TextFormatFlags.EndEllipsis);
        x += pw + Pad / 2;
        if (secondary != null && right - x > R(40))
            TextRenderer.DrawText(g, secondary, fontText, new Rectangle(x, Inset, right - x, Caption), FgDim, flags | TextFormatFlags.EndEllipsis);
    }

    /** What the well shows while there is no window to stream. */
    void DrawEmpty(Graphics g)
    {
        Color c = StateColor();
        int glyph = R(26);
        string title, sub;
        if (state == "done") { title = "Hand " + Id + " finished"; sub = "the result is in the panel"; }
        else if (state == "error") { title = "Hand " + Id + " stopped"; sub = "see the panel for what happened"; }
        else if (state == "review") { title = "Hand " + Id + " needs you"; sub = "approve or deny in the panel"; }
        else { title = "Hand " + Id + " is starting" + Ellipsis; sub = "waiting for its first window"; }

        TextFormatFlags flags = TextFormatFlags.SingleLine | TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis;
        int titleH = TextRenderer.MeasureText(g, title, fontTitle, new Size(int.MaxValue, int.MaxValue), flags).Height;
        int subH = TextRenderer.MeasureText(g, sub, fontText, new Size(int.MaxValue, int.MaxValue), flags).Height;
        int total = glyph + Pad + titleH + R(3) + subH;
        int y = body.Top + (body.Height - total) / 2;
        Rectangle gr = new Rectangle(body.Left + (body.Width - glyph) / 2, y, glyph, glyph);

        using (Pen pen = new Pen(c, Ring))
        {
            pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
            if (state == "done")
            {
                // Circle with a check.
                g.DrawEllipse(pen, gr);
                g.DrawLines(pen, new Point[] {
                    new Point(gr.Left + glyph * 28 / 100, gr.Top + glyph * 52 / 100),
                    new Point(gr.Left + glyph * 44 / 100, gr.Top + glyph * 68 / 100),
                    new Point(gr.Left + glyph * 73 / 100, gr.Top + glyph * 35 / 100) });
            }
            else if (state == "error")
            {
                // Circle with a cross.
                g.DrawEllipse(pen, gr);
                int a = glyph * 32 / 100, b = glyph * 68 / 100;
                g.DrawLine(pen, gr.Left + a, gr.Top + a, gr.Left + b, gr.Top + b);
                g.DrawLine(pen, gr.Left + b, gr.Top + a, gr.Left + a, gr.Top + b);
            }
            else
            {
                // Spinner: a 270-degree arc turning once every 1.2 s over a faint track.
                using (Pen track = new Pen(Alpha(c, 45), Ring)) g.DrawEllipse(track, gr);
                float start = (Now() % 1200u) / 1200f * 360f;
                g.DrawArc(pen, gr, start, 270f);
            }
        }
        y += glyph + Pad;
        TextRenderer.DrawText(g, title, fontTitle, new Rectangle(body.Left + Pad, y, body.Width - 2 * Pad, titleH), Fg, flags);
        y += titleH + R(3);
        TextRenderer.DrawText(g, sub, fontText, new Rectangle(body.Left + Pad, y, body.Width - 2 * Pad, subH), FgDim, flags);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            timer.Dispose();
            if (thumb != IntPtr.Zero) { DwmUnregisterThumbnail(thumb); thumb = IntPtr.Zero; }
            DisposeFonts();
        }
        base.Dispose(disposing);
    }
}

/** The pip mode: reads "hand ..." lines on a background thread, applies each on
 *  the UI thread, exits when stdin closes. One PipForm per hand id, created on
 *  first sight and given the next free slot in the bottom-right stack. */
static class Pip
{
    /** Slot positions stack upwards from the bottom-right corner with a fixed gap;
     *  when a column would run off the top of the screen the next slot starts a
     *  new column to the left. Slots are per hand id and never reflow, so hand 1
     *  is always in the same place. */
    public static Point Place(int slot, Size size, Rectangle area, int margin, int gap)
    {
        int perColumn = Math.Max(1, (area.Height - margin) / (size.Height + gap));
        int col = slot / perColumn, row = slot % perColumn;
        int x = area.Right - margin - size.Width - col * (size.Width + gap);
        int y = area.Bottom - margin - size.Height - row * (size.Height + gap);
        return new Point(Math.Max(area.Left, x), Math.Max(area.Top, y));
    }

    public static int Run()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        // serve.ts writes UTF-8; Console.In would otherwise decode with the OEM code
        // page and turn an accented title or the task/title separator into mojibake.
        // A reader over the raw handle, not Console.InputEncoding: that setter throws
        // when there is no console and changes the code page of a shared terminal.
        try { Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), false, 4096)); } catch (Exception) { }
        // Without this an unhandled exception on the UI thread opens the WinForms error
        // dialog, the only window in the helper that can take focus from the user.
        Application.ThreadException += delegate (object s, ThreadExceptionEventArgs a) { Console.Error.WriteLine("pip: " + a.Exception.Message); };
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
                    try
                    {
                        PipForm form;
                        if (!previews.TryGetValue(id, out form)) { form = new PipForm(id, previews.Count); previews[id] = form; }
                        form.Apply(new IntPtr(hwnd), state, label);
                    }
                    catch (Exception e) { Console.Error.WriteLine("pip: " + e.Message); }   // one bad line must not end the UI thread
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

// ------------------------------------------------------------------- hud

/** The caption the user sees while holding the hotkey, without looking at the
 *  browser: the live transcript, then which hand took which task. It hides
 *  itself; the previews (pip) take over from there. Protocol in the header.
 *
 *  A per-pixel-alpha layered window painted with GDI+ and pushed with
 *  UpdateLayeredWindow, so it has real anti-aliased corners and fades by alpha.
 *  It is a tool window that never activates and is transparent to the mouse:
 *  whatever the user was typing in keeps focus and every click falls through. */
class HudForm : Form
{
    // ---- Win32
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
    [StructLayout(LayoutKind.Sequential)] struct BLENDFUNCTION { public byte op, flags, alpha, format; }
    [DllImport("user32.dll", SetLastError = true)] static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr dstDc, ref POINT dst, ref SIZE size, IntPtr srcDc, ref POINT src, int key, ref BLENDFUNCTION blend, int flags);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern uint GetDpiForSystem();
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr handle);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);

    const int WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_TOPMOST = 0x8, WS_EX_LAYERED = 0x80000, WS_EX_NOACTIVATE = 0x08000000;
    const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4;
    const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;

    // Escapes, not literals: helper.cs has no BOM and csc falls back to the system ANSI page (see PipForm).
    static readonly string Dot = ((char)0x00B7).ToString();       // middle dot
    static readonly string Ellipsis = ((char)0x2026).ToString();  // horizontal ellipsis

    // ---- palette: the same numbers as PipForm, so a hand chip here is the ring colour of its preview
    static readonly Color Card = Color.FromArgb(237, 18, 20, 28);
    static readonly Color Edge = Color.FromArgb(22, 255, 255, 255);
    static readonly Color Fg = Color.FromArgb(232, 236, 245);
    static readonly Color Muted = Color.FromArgb(141, 149, 169);
    static readonly Color Faint = Color.FromArgb(92, 100, 121);
    static readonly Color Ink = Color.FromArgb(11, 18, 32);
    static readonly Color Live = Color.FromArgb(158, 206, 106);     // listening, done
    static readonly Color Working = Color.FromArgb(122, 162, 247);  // finishing, running
    static readonly Color Review = Color.FromArgb(224, 175, 104);
    static readonly Color Failed = Color.FromArgb(247, 118, 142);
    static readonly Color Idle = Color.FromArgb(65, 72, 104);

    // ---- model
    enum Phase { Hidden, Listening, Finishing, Settled, Nothing, Error, Cancelled }
    class Row { public int Id, Hand; public string Status = "", Request = "", Progress = ""; }

    // hotkey.ts gives the transcriber 15 s after release; a dead one must not leave the card up.
    const int MaxRows = 4, FinishingMaxMs = 20000;

    Phase phase = Phase.Hidden;
    string transcript = "", error = "";
    readonly List<Row> rows = new List<Row>();
    readonly Stopwatch clock = Stopwatch.StartNew();
    long phaseAt, hideAt;
    bool showing, onScreen, dirty;
    double alpha;
    long lastTick;
    readonly System.Windows.Forms.Timer ticker = new System.Windows.Forms.Timer();

    // ---- typography, resolved once
    readonly string face;
    readonly int dpi;

    // PUK_HUD_TRACE=1 narrates commands and Win32 results on stderr (serve.ts pipes it; PUK_DEBUG shows it).
    static readonly bool trace = Environment.GetEnvironmentVariable("PUK_HUD_TRACE") == "1";
    static void Trace(string message) { if (trace) { Console.Error.WriteLine("hud: " + message); Console.Error.Flush(); } }

    public HudForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        SetStyle(ControlStyles.Opaque | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint, true);
        face = FontFace();
        dpi = Dpi();
        ticker.Interval = 16;
        ticker.Tick += Tick;
        IntPtr created = Handle; // create the window now; it stays hidden until "listening"
    }

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get { CreateParams p = base.CreateParams; p.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE; return p; }
    }
    protected override void OnPaintBackground(PaintEventArgs e) { } // the layered surface is the picture
    protected override void OnPaint(PaintEventArgs e) { }

    static string FontFace()
    {
        foreach (string name in new string[] { "Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI" })
        {
            try { using (FontFamily f = new FontFamily(name)) return name; } catch (Exception) { }
        }
        return FontFamily.GenericSansSerif.Name;
    }

    /** GDI+ refuses a style a face lacks (variable Segoe has no synthesised bold on
     *  some builds); fall back a face at a time rather than lose the whole card. */
    Font MakeFont(double pixels, FontStyle style)
    {
        foreach (string name in new string[] { face, "Segoe UI", FontFamily.GenericSansSerif.Name })
        {
            try { return new Font(name, (float)pixels, style, GraphicsUnit.Pixel); } catch (Exception) { }
        }
        return new Font(FontFamily.GenericSansSerif, (float)pixels, FontStyle.Regular, GraphicsUnit.Pixel);
    }

    static int Dpi()
    {
        try { uint d = GetDpiForSystem(); if (d >= 72) return (int)d; } catch (Exception) { }
        try { using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) return (int)g.DpiY; } catch (Exception) { return 96; }
    }

    long Now { get { return clock.ElapsedMilliseconds; } }

    // ---- protocol

    public void Apply(string line)
    {
        string[] head = line.Split(new char[] { ' ' }, 2);
        string command = head[0], rest = head.Length > 1 ? head[1] : "";
        Trace("<- " + command + (rest.Length > 0 ? " (" + rest.Length + " chars)" : ""));
        if (command == "listening")
        {
            transcript = ""; error = ""; rows.Clear();
            Switch(Phase.Listening, 0);
            Reveal();
        }
        else if (command == "transcript") { transcript = rest; dirty = true; }
        else if (command == "finishing") { if (phase == Phase.Listening) Switch(Phase.Finishing, FinishingMaxMs); }
        else if (command == "task")
        {
            string[] p = line.Split(new char[] { ' ' }, 5);
            int id, hand;
            if (p.Length < 4 || !int.TryParse(p[1], out id) || !int.TryParse(p[3], out hand)) return;
            Row row = null;
            foreach (Row r in rows) if (r.Id == id) row = r;
            if (row == null) { row = new Row(); row.Id = id; rows.Add(row); }
            row.Status = p[2]; row.Hand = hand; row.Request = p.Length > 4 ? p[4] : "";
            if (row.Status != "running") row.Progress = "";
            dirty = true;
        }
        else if (command == "progress")
        {
            string[] p = line.Split(new char[] { ' ' }, 3);
            int hand;
            if (p.Length < 3 || !int.TryParse(p[1], out hand)) return;
            foreach (Row r in rows) if (r.Hand == hand && r.Status == "running") r.Progress = p[2];
            dirty = true;
        }
        else if (command == "settle") { if (rows.Count > 0) Switch(Phase.Settled, 2600); else Switch(Phase.Nothing, 1400); }
        else if (command == "nothing") Switch(Phase.Nothing, 1400);
        else if (command == "error") { error = rest; Switch(Phase.Error, 4000); Reveal(); }
        else if (command == "cancelled") Switch(Phase.Cancelled, 900);
        else if (command == "hide") { showing = false; hideAt = 0; }
    }

    void Switch(Phase next, int holdMs)
    {
        if (next != Phase.Listening && next != Phase.Error && phase == Phase.Hidden) return; // nothing on screen to update
        phase = next; phaseAt = Now; dirty = true;
        hideAt = holdMs > 0 ? Now + holdMs : 0;
    }

    void Reveal()
    {
        showing = true;
        if (!onScreen)
        {
            onScreen = true;
            alpha = 0; lastTick = Now;
            Render(); // a first frame at alpha 0, so the window never flashes its previous picture
            ShowWindow(Handle, SW_SHOWNOACTIVATE);
            SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); // HWND_TOPMOST
            Trace("shown; visible=" + IsWindowVisible(Handle) + " bounds=" + Bounds);
            try { VirtualDesktop.Desktop.PinWindow(Handle); } catch (Exception) { } // follows the user into a hand's desktop
        }
        if (!ticker.Enabled) { lastTick = Now; ticker.Start(); }
    }

    // ---- animation: 120 ms in, 220 ms out, a pulse only while listening

    void Tick(object sender, EventArgs e)
    {
        long now = Now;
        double dt = Math.Max(1, now - lastTick);
        lastTick = now;
        if (hideAt > 0 && now >= hideAt) { showing = false; hideAt = 0; }
        double target = showing ? 1 : 0;
        if (alpha < target) alpha = Math.Min(1, alpha + dt / 120.0);
        else if (alpha > target) alpha = Math.Max(0, alpha - dt / 220.0);
        if (!showing && alpha <= 0)
        {
            ShowWindow(Handle, SW_HIDE);
            onScreen = false; phase = Phase.Hidden;
            ticker.Stop();
            return;
        }
        bool animating = alpha != target || phase == Phase.Listening;
        if (dirty || animating) Render();
    }

    // ---- drawing

    float Px(double logical) { return (float)(logical * dpi / 96.0); }
    float Pt(double points) { return (float)(points * dpi / 72.0); }

    static GraphicsPath Rounded(RectangleF r, float radius)
    {
        GraphicsPath path = new GraphicsPath();
        float d = radius * 2;
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    /** The newest words matter while someone is speaking: when the text is longer
     *  than maxLines, words are dropped from the front and an ellipsis leads. */
    static string FitTail(Graphics g, string text, Font font, float width, int maxLines, StringFormat format, out int lines)
    {
        float lineHeight = font.GetHeight(g);
        // Coarse cut first, so a 16 000-character transcript is not measured word by word.
        int perLine = Math.Max(8, (int)(width / (font.Size * 0.48f)));
        int keep = perLine * (maxLines + 2);
        string t = text;
        bool cut = false;
        if (t.Length > keep)
        {
            int at = t.IndexOf(' ', t.Length - keep);
            t = at > 0 ? t.Substring(at + 1) : t.Substring(t.Length - keep);
            cut = true;
        }
        for (;;)
        {
            string shown = cut ? Ellipsis + " " + t : t;
            SizeF size = g.MeasureString(shown, font, (int)width, format);
            lines = Math.Max(1, (int)Math.Round(size.Height / lineHeight));
            if (lines <= maxLines || t.Length < 2) return shown;
            int space = t.IndexOf(' ');
            t = space > 0 ? t.Substring(space + 1) : t.Substring(t.Length / 4);
            cut = true;
        }
    }

    Color Accent()
    {
        switch (phase)
        {
            case Phase.Listening: return Live;
            case Phase.Finishing: return Working;
            case Phase.Settled: return Working;
            case Phase.Error: return Failed;
            default: return Idle;
        }
    }

    string Header()
    {
        switch (phase)
        {
            case Phase.Listening: return "LISTENING";
            case Phase.Finishing: return "FINISHING";
            case Phase.Settled: return "HANDED OFF";
            case Phase.Nothing: return "NOTHING TO DO";
            case Phase.Error: return "STOPPED";
            case Phase.Cancelled: return "CANCELLED";
            default: return "";
        }
    }

    /** State colour, as PipForm's ring and badge: every working hand is the same blue. */
    static Color RowColor(string status)
    {
        if (status == "running") return Working;
        if (status == "done") return Live;
        if (status == "failed") return Failed;
        return Idle; // waiting, cancelled
    }

    void Render()
    {
        dirty = false;
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        double scale = dpi / 96.0;
        int width = (int)Math.Min(Math.Max(area.Width * 0.36, 520 * scale), 720 * scale);
        width = Math.Min(width, area.Width - (int)Px(32));
        bool tall = area.Height / scale >= 1000;
        float bodyPt = tall ? 17f : 15f, smallPt = tall ? 10.5f : 10f, capsPt = 9.5f;
        float padX = Px(22), padY = Px(16), accent = Px(3), radius = Px(14), gap = Px(8);
        float headerH = Px(18), rowH = Px(28);
        float inner = width - padX * 2 - accent;
        long now = Now;

        using (Font body = MakeFont(Pt(bodyPt), FontStyle.Regular))
        using (Font small = MakeFont(Pt(smallPt), FontStyle.Regular))
        using (Font caps = MakeFont(Pt(capsPt), FontStyle.Bold))
        using (Font chipFont = MakeFont(Pt(9.5), FontStyle.Bold))
        using (StringFormat wrap = new StringFormat(StringFormatFlags.LineLimit))
        using (StringFormat oneLine = new StringFormat(StringFormat.GenericTypographic)) // no side padding: measured == drawn
        using (StringFormat centered = new StringFormat())
        {
            wrap.Trimming = StringTrimming.EllipsisWord;
            oneLine.FormatFlags |= StringFormatFlags.NoWrap;
            oneLine.Trimming = StringTrimming.EllipsisCharacter;
            oneLine.LineAlignment = StringAlignment.Center;
            centered.Alignment = StringAlignment.Center; centered.LineAlignment = StringAlignment.Center;

            // Measure with a scratch surface, then allocate the exact card.
            string bodyText; Color bodyColor; int bodyLines;
            string subline = null;
            using (Bitmap scratch = new Bitmap(1, 1))
            using (Graphics m = Graphics.FromImage(scratch))
            {
                m.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                if (phase == Phase.Error) { bodyText = FitTail(m, error, body, inner, 3, wrap, out bodyLines); bodyColor = Fg; }
                else if (transcript.Length > 0) { bodyText = FitTail(m, transcript, body, inner, 3, wrap, out bodyLines); bodyColor = Fg; }
                else
                {
                    bodyLines = 1; bodyColor = Faint;
                    bodyText = phase == Phase.Nothing ? "No request heard." : phase == Phase.Cancelled ? "Cancelled." : "Speak now.";
                }
                long inPhase = now - phaseAt;
                if (phase == Phase.Listening && transcript.Length == 0 && inPhase > 2500) subline = "waiting for the transcriber" + Ellipsis;
                if (phase == Phase.Finishing && inPhase > 1500) subline = "still transcribing" + Ellipsis;
            }
            float bodyH = body.GetHeight() * bodyLines;
            float sublineH = subline != null ? small.GetHeight() + Px(2) : 0;
            // More rows than fit are counted, not hidden: the previews show every hand anyway.
            int shownRows = Math.Min(rows.Count, MaxRows), moreRows = rows.Count - shownRows;
            float rowsH = shownRows > 0 ? gap + rowH * shownRows + (moreRows > 0 ? rowH : 0) : 0;
            int height = (int)Math.Ceiling(padY + headerH + gap + bodyH + sublineH + rowsH + padY);

            using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(bitmap))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit; // ClearType fringes on a transparent surface
                    g.Clear(Color.Transparent);

                    RectangleF card = new RectangleF(0.5f, 0.5f, width - 1, height - 1);
                    using (GraphicsPath path = Rounded(card, radius))
                    {
                        using (SolidBrush fill = new SolidBrush(Card)) g.FillPath(fill, path);
                        // The state bar: clipped to the card so its corners stay round.
                        g.SetClip(path);
                        using (SolidBrush bar = new SolidBrush(Accent())) g.FillRectangle(bar, 0, 0, accent + 1, height);
                        g.ResetClip();
                        using (Pen edge = new Pen(Edge, 1f)) g.DrawPath(edge, path);
                    }

                    float x = accent + padX, y = padY;

                    // Header: a dot (pulsing only while listening), the phase in small caps.
                    float dot = Px(4), cx = x + dot, cy = y + headerH / 2;
                    Color tone = Accent();
                    if (phase == Phase.Listening)
                    {
                        double t = ((now - phaseAt) % 1200) / 1200.0;
                        float ring = dot + (float)(Px(7) * t);
                        using (SolidBrush halo = new SolidBrush(Color.FromArgb((int)(140 * (1 - t)), tone))) g.FillEllipse(halo, cx - ring, cy - ring, ring * 2, ring * 2);
                    }
                    using (SolidBrush b = new SolidBrush(tone)) g.FillEllipse(b, cx - dot, cy - dot, dot * 2, dot * 2);
                    if (phase == Phase.Settled)
                    {
                        using (Pen check = new Pen(Ink, Px(1.6f)))
                        {
                            check.StartCap = LineCap.Round; check.EndCap = LineCap.Round;
                            g.DrawLines(check, new PointF[] { new PointF(cx - Px(2), cy), new PointF(cx - Px(0.5), cy + Px(1.6)), new PointF(cx + Px(2.2), cy - Px(1.8)) });
                        }
                    }
                    using (SolidBrush b = new SolidBrush(Muted))
                    {
                        // Letter-spaced small caps: GDI+ has no tracking, so space the characters by hand.
                        string header = Header();
                        float hx = cx + dot + Px(10);
                        foreach (char c in header)
                        {
                            string s = c.ToString();
                            g.DrawString(s, caps, b, hx, cy - caps.GetHeight(g) / 2 - Px(0.5), oneLine);
                            hx += (c == ' ' ? Px(5) : g.MeasureString(s, caps, 1000, oneLine).Width) + Px(1.8);
                        }
                    }
                    y += headerH + gap;

                    // Body: the transcript, three lines at most, newest words kept.
                    using (SolidBrush b = new SolidBrush(bodyColor)) g.DrawString(bodyText, body, b, new RectangleF(x, y, inner, bodyH + 2), wrap);
                    y += bodyH;
                    if (subline != null)
                    {
                        using (SolidBrush b = new SolidBrush(Faint)) g.DrawString(subline, small, b, x, y + Px(2), oneLine);
                        y += sublineH;
                    }

                    // Rows: one per task. The chip is the hand's ring colour on its preview.
                    if (shownRows > 0)
                    {
                        y += gap;
                        for (int i = 0; i < shownRows; i++)
                        {
                            Row row = rows[i];
                            Color c = RowColor(row.Status);
                            bool filled = row.Status == "running" || row.Status == "done" || row.Status == "failed";
                            string chip = row.Hand > 0 ? "HAND " + row.Hand : row.Status == "waiting" ? "QUEUED" : row.Status.ToUpperInvariant();
                            float chipH = Px(18), chipW = g.MeasureString(chip, chipFont, 1000, oneLine).Width + Px(14);
                            RectangleF pill = new RectangleF(x, y + (rowH - chipH) / 2, chipW, chipH);
                            using (GraphicsPath p = Rounded(pill, chipH / 2))
                            {
                                if (filled) { using (SolidBrush b = new SolidBrush(c)) g.FillPath(b, p); }
                                else { using (Pen pen = new Pen(c, 1f)) g.DrawPath(pen, p); }
                            }
                            using (SolidBrush b = new SolidBrush(filled ? Ink : Muted)) g.DrawString(chip, chipFont, b, pill, centered);

                            string what = row.Request;
                            if (row.Status == "done") what = what + "  " + Dot + "  done";
                            else if (row.Status == "failed") what = what + "  " + Dot + "  failed";
                            else if (row.Status == "cancelled") what = what + "  " + Dot + "  cancelled";
                            float tx = pill.Right + Px(12);
                            RectangleF line = new RectangleF(tx, y, inner - (tx - x), rowH);
                            if (row.Progress.Length > 0 && row.Status == "running")
                            {
                                // "request  <dot>  Opening Chrome": the progress muted, the request truncated first.
                                string tail = "  " + Dot + "  " + row.Progress;
                                float tailW = Math.Min(g.MeasureString(tail, small, 1000, oneLine).Width, line.Width * 0.5f);
                                using (SolidBrush b = new SolidBrush(Fg)) g.DrawString(what, small, b, new RectangleF(line.X, line.Y, line.Width - tailW, line.Height), oneLine);
                                float used = Math.Min(g.MeasureString(what, small, (int)(line.Width - tailW), oneLine).Width + Px(2), line.Width - tailW);
                                using (SolidBrush b = new SolidBrush(Muted)) g.DrawString(tail, small, b, new RectangleF(line.X + used, line.Y, tailW, line.Height), oneLine);
                            }
                            else
                            {
                                using (SolidBrush b = new SolidBrush(row.Status == "cancelled" ? Muted : Fg)) g.DrawString(what, small, b, line, oneLine);
                            }
                            y += rowH;
                        }
                        if (moreRows > 0)
                        {
                            using (SolidBrush b = new SolidBrush(Muted)) g.DrawString("+" + moreRows + " more", small, b, new RectangleF(x, y, inner, rowH), oneLine);
                        }
                    }
                }

                // Bottom centre of the primary screen, above the taskbar; rises 10 px as it fades in.
                int px = area.Left + (area.Width - width) / 2;
                int py = area.Bottom - height - (int)Px(48) + (int)(Px(10) * (1 - alpha));
                Push(bitmap, px, py, (byte)Math.Round(255 * Math.Min(1, Math.Max(0, alpha))));
            }
        }
    }

    void Push(Bitmap bitmap, int x, int y, byte opacity)
    {
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr memory = CreateCompatibleDC(screen);
        IntPtr hBitmap = IntPtr.Zero, previous = IntPtr.Zero;
        try
        {
            hBitmap = bitmap.GetHbitmap(Color.FromArgb(0));
            previous = SelectObject(memory, hBitmap);
            POINT at = new POINT(); at.x = x; at.y = y;
            SIZE size = new SIZE(); size.cx = bitmap.Width; size.cy = bitmap.Height;
            POINT origin = new POINT();
            BLENDFUNCTION blend = new BLENDFUNCTION();
            blend.op = 0; blend.flags = 0; blend.alpha = opacity; blend.format = 1; // AC_SRC_OVER, AC_SRC_ALPHA
            bool ok = UpdateLayeredWindow(Handle, screen, ref at, ref size, memory, ref origin, 0, ref blend, 2); // ULW_ALPHA
            if (!ok) Trace("UpdateLayeredWindow failed, error " + Marshal.GetLastWin32Error() + " at " + x + "," + y + " " + size.cx + "x" + size.cy);
        }
        finally
        {
            if (previous != IntPtr.Zero) SelectObject(memory, previous);
            if (hBitmap != IntPtr.Zero) DeleteObject(hBitmap);
            DeleteDC(memory);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }
}

/** The hud mode: reads command lines on a background thread, applies each on the
 *  UI thread, exits when stdin closes. */
static class Hud
{
    public static int Run()
    {
        Application.EnableVisualStyles();
        // Transcripts are not ASCII. A reader over the raw handle, as in Pip.Run: the
        // Console.InputEncoding setter throws without a console and changes a shared terminal's code page.
        try { Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), false, 4096)); } catch (Exception) { }
        // The WinForms error dialog is the only window here that could take focus from the user.
        Application.ThreadException += delegate (object s, ThreadExceptionEventArgs a) { Console.Error.WriteLine("hud: " + a.Exception.Message); };
        HudForm hud = new HudForm(); // owns the UI thread; shown by "listening"
        Thread reader = new Thread(delegate ()
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                string captured = line.Trim().TrimStart((char)0xFEFF); // a redirected console may lead with a BOM
                if (captured.Length == 0) continue;
                try { hud.BeginInvoke((MethodInvoker)delegate () { try { hud.Apply(captured); } catch (Exception e) { Console.Error.WriteLine("hud: " + e.Message); } }); }
                catch (Exception) { break; } // the form is gone
            }
            try { hud.BeginInvoke((MethodInvoker)delegate () { Application.Exit(); }); } catch (Exception) { }
        });
        reader.IsBackground = true;
        reader.Start();
        Application.Run();
        return 0;
    }
}
