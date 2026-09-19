// The native half of windows.ts: one command per run, JSON on stdout. Built on first use with the C# compiler that
// ships in Windows (.NET Framework 4, so C# 5: no interpolation, no `?.`), which is why nothing needs installing.
// Four modes are the exception and stay running until their stdin closes: `mic` and `hotkey`, the ears of
// `hands --listen` (see "voice" at the end), `feed`, the windows the user watches (feed.cs), and `devtools`, the
// browser's socket held for a caller that cannot reach it (devtools.ts).
//
// Everything that names a window works on one that is covered, and none of it activates anything:
//   - capture is PrintWindow, which asks the window to paint itself into a bitmap wherever it sits in the stack
//   - a press is a UI Automation pattern (Invoke, Toggle, Select, Expand), which needs no pointer and no focus
//   - text goes to a classic edit control as EM_REPLACESEL. ValuePattern.SetValue would give it the keyboard
//     focus first, which activates its window and puts it in front of the user
//   - a window is closed with WM_CLOSE, never by ending its process: ApplicationFrameHost hosts Calculator
//     next to the user's own Settings and Sticky Notes
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

static class Hands
{
    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, string lParam);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT point, uint flags);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        SetProcessDPIAware(); // or every rectangle is in scaled units while PrintWindow paints real pixels
        string mode = args.Length > 0 ? args[0] : "";
        if (mode == "feed") return Feed.Run(); // feed.cs: the windows the user watches, told what to show on stdin
        if (mode == "devtools") return Devtools(args.Length > 1 ? Int(args[1]) : 0); // the browser's socket, a line per message
        if (mode == "mic" || mode == "hotkey")
        {
            // stdout is the stream itself here, so a failure goes to stderr as a plain line.
            try { WatchStdin(); return mode == "mic" ? Mic() : Hotkey(args.Length > 1 ? Int(args[1]) : 0x77 /* F8 */); }
            catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
        }
        try { Console.Out.Write(Run(args)); return 0; }
        catch (Exception e) { Console.Out.Write("{\"error\":" + Quote(e.Message) + "}"); return 1; }
    }

    static string Run(string[] a)
    {
        switch (a.Length > 0 ? a[0] : "")
        {
            case "windows": return Windows();
            case "grab": return Grab(Handle(a[1]), a[2], a.Length > 6 ? new Rectangle(Int(a[3]), Int(a[4]), Int(a[5]), Int(a[6])) : Rectangle.Empty);
            case "tree": return Tree(Handle(a[1]));
            case "act": return Act(Handle(a[1]), a[2], a[3], a.Length > 4 ? Text(a[4]) : "");
            case "close": PostMessage(Handle(a[1]), 0x0010 /* WM_CLOSE */, IntPtr.Zero, IntPtr.Zero); return "{\"ok\":true}";
            case "behind": return Behind(Handle(a[1]), a.Length > 2 ? Handle(a[2]) : IntPtr.Zero);
            case "front": return "{\"ok\":" + Bool(SetForegroundWindow(Handle(a[1]))) + "}";
            case "launch": return Launch(Text(a[1]), a.Length > 2 ? Text(a[2]) : "", a.Length > 3 && a[3] == "background");
            case "key": return Key(Handle(a[1]), Int(a[2]), a.Length > 3 ? a[3] : "");
            case "pointer": return Pointer(Handle(a[1]), a);
            case "input": return Input(a);
            default: throw new ArgumentException("unknown command");
        }
    }

    // ---------------------------------------------------------------- windows

    static string Windows()
    {
        StringBuilder json = new StringBuilder("{\"foreground\":" + GetForegroundWindow().ToInt64());
        POINT cursor; GetCursorPos(out cursor);
        json.Append(",\"cursor\":[" + cursor.X + "," + cursor.Y + "],\"displays\":[");
        System.Windows.Forms.Screen[] screens = System.Windows.Forms.Screen.AllScreens;
        Array.Sort(screens, delegate (System.Windows.Forms.Screen x, System.Windows.Forms.Screen y) { return y.Primary.CompareTo(x.Primary); }); // the main one first
        for (int i = 0; i < screens.Length; i++) { Rectangle b = screens[i].Bounds; json.Append((i > 0 ? "," : "") + "[" + b.X + "," + b.Y + "," + b.Width + "," + b.Height + "]"); }
        json.Append("],\"windows\":[");
        bool first = true;
        // EnumWindows goes front to back, which is the order appWindows promises.
        EnumWindows(delegate (IntPtr hwnd, IntPtr l)
        {
            RECT r; int cloaked;
            if (!IsWindowVisible(hwnd) || !GetWindowRect(hwnd, out r) || GetWindow(hwnd, 4 /* GW_OWNER */) != IntPtr.Zero) return true;
            if ((GetWindowLong(hwnd, -20 /* GWL_EXSTYLE */) & 0x80 /* WS_EX_TOOLWINDOW */) != 0) return true;
            // A cloaked window is a suspended Store app or one on another virtual desktop: listed, it would be offered as on screen.
            if (DwmGetWindowAttribute(hwnd, 14 /* DWMWA_CLOAKED */, out cloaked, 4) == 0 && cloaked != 0) return true;
            string title = TextOf(hwnd);
            if (title.Length == 0) return true;
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            string app = "";
            try { app = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { /* it exited between the two calls */ }
            json.Append((first ? "" : ",") + "{\"id\":" + hwnd.ToInt64() + ",\"pid\":" + pid + ",\"app\":" + Quote(app) + ",\"title\":" + Quote(title)
                + ",\"minimized\":" + Bool(IsIconic(hwnd)) + ",\"frame\":[" + r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top) + "]}");
            first = false;
            return true;
        }, IntPtr.Zero);
        return json.Append("]}").ToString();
    }

    static string Grab(IntPtr hwnd, string path, Rectangle region)
    {
        if (hwnd == IntPtr.Zero)
        {
            using (Bitmap screen = new Bitmap(region.Width, region.Height))
            {
                using (Graphics g = Graphics.FromImage(screen)) g.CopyFromScreen(region.Location, Point.Empty, region.Size);
                screen.Save(path, ImageFormat.Png);
                return "{\"width\":" + screen.Width + ",\"height\":" + screen.Height + "}";
            }
        }
        RECT r;
        if (!GetWindowRect(hwnd, out r) || IsIconic(hwnd)) throw new InvalidOperationException("the window is gone or minimized, and a minimized window paints nothing");
        using (Bitmap shot = new Bitmap(Math.Max(1, r.Right - r.Left), Math.Max(1, r.Bottom - r.Top)))
        {
            using (Graphics g = Graphics.FromImage(shot))
            {
                IntPtr hdc = g.GetHdc();
                // PW_RENDERFULLCONTENT: without it a Chromium or WinUI window comes back black, since they draw with the GPU.
                bool painted = PrintWindow(hwnd, hdc, 2);
                g.ReleaseHdc(hdc);
                if (!painted) throw new InvalidOperationException("the window would not paint itself");
            }
            shot.Save(path, ImageFormat.Png);
            return "{\"width\":" + shot.Width + ",\"height\":" + shot.Height + "}";
        }
    }

    // ---------------------------------------------------------------- the accessibility tree

    static readonly AutomationProperty[] Wanted = {
        AutomationElement.ControlTypeProperty, AutomationElement.NameProperty, AutomationElement.BoundingRectangleProperty, AutomationElement.RuntimeIdProperty,
        AutomationElement.IsOffscreenProperty, AutomationElement.IsEnabledProperty, AutomationElement.HasKeyboardFocusProperty, AutomationElement.IsPasswordProperty,
        AutomationElement.HelpTextProperty, ValuePattern.ValueProperty, AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsTogglePatternAvailableProperty,
        AutomationElement.IsSelectionItemPatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty,
        AutomationElement.IsScrollItemPatternAvailableProperty, AutomationElement.IsScrollPatternAvailableProperty };

    static List<IntPtr> Roots(IntPtr hwnd)
    {
        // Asked through its top-level handle, a window that is covered or on another desktop can stop at its title bar
        // (Paint: 7 nodes), while the content's own child windows, the WinUI islands and the classic controls, still
        // answer (Paint: 84). So each child window is read as a root too, and what was already seen is skipped.
        List<IntPtr> roots = new List<IntPtr>();
        roots.Add(hwnd);
        EnumChildWindows(hwnd, delegate (IntPtr child, IntPtr l) { roots.Add(child); return true; }, IntPtr.Zero);
        // A Store app is two windows: the frame, and its content in a CoreWindow of the same title.
        if (ClassOf(hwnd) == "ApplicationFrameWindow")
        {
            string title = TextOf(hwnd);
            EnumWindows(delegate (IntPtr top, IntPtr l) { if (ClassOf(top) == "Windows.UI.Core.CoreWindow" && TextOf(top) == title) roots.Add(top); return true; }, IntPtr.Zero);
        }
        return roots;
    }

    static string Tree(IntPtr hwnd)
    {
        CacheRequest request = new CacheRequest();
        foreach (AutomationProperty property in Wanted) request.Add(property);
        request.TreeScope = TreeScope.Element | TreeScope.Descendants;
        request.TreeFilter = Automation.ControlViewCondition;
        StringBuilder json = new StringBuilder("{\"nodes\":[");
        HashSet<string> seen = new HashSet<string>();
        int count = 0;
        foreach (IntPtr root in Roots(hwnd))
        {
            if (count >= 4000) break; // macos.ts AX_NODE_CAP
            try
            {
                AutomationElement top;
                using (request.Activate()) top = AutomationElement.FromHandle(root);
                Walk(top, -1, root, json, seen, ref count);
            }
            catch (Exception) { /* a child window that went away, or one with no provider */ }
        }
        return json.Append("]}").ToString();
    }

    static void Walk(AutomationElement el, int parent, IntPtr root, StringBuilder json, HashSet<string> seen, ref int count)
    {
        string id = string.Join(".", Array.ConvertAll((int[])el.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty), delegate (int part) { return part.ToString(CultureInfo.InvariantCulture); }));
        if (count >= 4000 || !seen.Add(id)) return;
        int index = count++;
        System.Windows.Rect r = (System.Windows.Rect)el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
        ControlType type = (ControlType)el.GetCachedPropertyValue(AutomationElement.ControlTypeProperty);
        List<string> actions = new List<string>();
        if (Flag(el, AutomationElement.IsInvokePatternAvailableProperty)) actions.Add("invoke");
        if (Flag(el, AutomationElement.IsTogglePatternAvailableProperty)) actions.Add("toggle");
        if (Flag(el, AutomationElement.IsSelectionItemPatternAvailableProperty)) actions.Add("select");
        if (Flag(el, AutomationElement.IsExpandCollapsePatternAvailableProperty)) actions.Add("expand");
        if (Flag(el, AutomationElement.IsValuePatternAvailableProperty)) actions.Add("value");
        if (Flag(el, AutomationElement.IsScrollItemPatternAvailableProperty)) actions.Add("show");
        if (Flag(el, AutomationElement.IsScrollPatternAvailableProperty)) actions.Add("scroll");
        bool password = Flag(el, AutomationElement.IsPasswordProperty);
        object value = password ? null : el.GetCachedPropertyValue(ValuePattern.ValueProperty, true);
        json.Append((index > 0 ? "," : "") + "{\"ref\":" + Quote(root.ToInt64() + ":" + id) + ",\"parent\":" + parent
            + ",\"type\":" + Quote(type == null ? "" : type.ProgrammaticName.Replace("ControlType.", ""))
            + ",\"name\":" + Quote(Clean(el.GetCachedPropertyValue(AutomationElement.NameProperty) as string))
            + ",\"help\":" + Quote(Clean(el.GetCachedPropertyValue(AutomationElement.HelpTextProperty) as string))
            + ",\"value\":" + Quote(Clean(value as string))
            + ",\"frame\":" + (r.IsEmpty || double.IsInfinity(r.Width) ? "null" : "[" + Num(r.X) + "," + Num(r.Y) + "," + Num(r.Width) + "," + Num(r.Height) + "]")
            + ",\"offscreen\":" + Bool(Flag(el, AutomationElement.IsOffscreenProperty)) + ",\"enabled\":" + Bool(Flag(el, AutomationElement.IsEnabledProperty))
            + ",\"focused\":" + Bool(Flag(el, AutomationElement.HasKeyboardFocusProperty)) + ",\"password\":" + Bool(password)
            + ",\"actions\":[" + string.Join(",", actions.ConvertAll<string>(Quote).ToArray()) + "]}");
        foreach (AutomationElement child in el.CachedChildren) Walk(child, index, root, json, seen, ref count);
    }

    /** The element a `tree` named, found again by its runtime id under the root it was read from. */
    static AutomationElement Find(string reference)
    {
        string[] parts = reference.Split(':');
        int[] id = Array.ConvertAll(parts[1].Split('.'), delegate (string part) { return int.Parse(part, CultureInfo.InvariantCulture); });
        AutomationElement root = AutomationElement.FromHandle(new IntPtr(long.Parse(parts[0], CultureInfo.InvariantCulture)));
        AutomationElement found = root.FindFirst(TreeScope.Element | TreeScope.Descendants, new PropertyCondition(AutomationElement.RuntimeIdProperty, id));
        if (found == null) throw new InvalidOperationException("the control is gone");
        return found;
    }

    static string Act(IntPtr window, string reference, string verb, string text)
    {
        AutomationElement el = Find(reference);
        IntPtr before = GetForegroundWindow();
        object pattern;
        bool ok = false;
        string value = null;
        if (verb == "press")
        {
            if (el.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); ok = true; }
            else if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) { ((SelectionItemPattern)pattern).Select(); ok = true; }
            else if (el.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { ((TogglePattern)pattern).Toggle(); ok = true; }
            else if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
            {
                ExpandCollapsePattern fold = (ExpandCollapsePattern)pattern;
                if (fold.Current.ExpandCollapseState == ExpandCollapseState.Expanded) fold.Collapse(); else fold.Expand();
                ok = true;
            }
        }
        else if (verb == "show" && el.TryGetCurrentPattern(ScrollItemPattern.Pattern, out pattern)) { ((ScrollItemPattern)pattern).ScrollIntoView(); ok = true; }
        else if ((verb == "up" || verb == "down" || verb == "left" || verb == "right") && el.TryGetCurrentPattern(ScrollPattern.Pattern, out pattern))
        {
            ScrollPattern scroll = (ScrollPattern)pattern;
            ScrollAmount page = verb == "up" || verb == "left" ? ScrollAmount.LargeDecrement : ScrollAmount.LargeIncrement;
            if (verb == "up" || verb == "down") { if (scroll.Current.VerticallyScrollable) { scroll.ScrollVertical(page); ok = true; } }
            else if (scroll.Current.HorizontallyScrollable) { scroll.ScrollHorizontal(page); ok = true; }
        }
        else if (verb == "value") { value = el.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) ? ((ValuePattern)pattern).Current.Value : null; ok = value != null; }
        else if (verb == "set")
        {
            // Measured: ValuePattern.SetValue on a classic edit control gives it the keyboard focus first, which activates its
            // window. An edit control with a window of its own takes its text as a message instead: select all, replace the
            // selection. That is what typing does (change notifications, undo), and no focus is involved.
            object handle = el.GetCurrentPropertyValue(AutomationElement.NativeWindowHandleProperty, true);
            IntPtr edit = handle is int && (int)handle != 0 ? new IntPtr((int)handle) : IntPtr.Zero;
            string kind = edit != IntPtr.Zero ? ClassOf(edit) : "";
            if (kind == "Edit" || kind.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase))
            {
                SendMessage(edit, 0x00B1 /* EM_SETSEL */, IntPtr.Zero, new IntPtr(-1));
                SendMessage(edit, 0x00C2 /* EM_REPLACESEL */, new IntPtr(1), text);
                ok = true;
            }
            else if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && !((ValuePattern)pattern).Current.IsReadOnly) { ((ValuePattern)pattern).SetValue(text); ok = true; }
        }
        // Whatever an app did in answer, the user keeps the window they were in.
        bool took = before != IntPtr.Zero && GetForegroundWindow() != before;
        if (took) SetForegroundWindow(before);
        return "{\"ok\":" + Bool(ok) + ",\"tookFocus\":" + Bool(took) + ",\"value\":" + (value == null ? "null" : Quote(value)) + "}";
    }

    // ---------------------------------------------------------------- apps and input

    static string Launch(string file, string arguments, bool background)
    {
        IntPtr before = GetForegroundWindow();
        ProcessStartInfo info = new ProcessStartInfo(file, arguments);
        info.UseShellExecute = true; // so a Start menu AppID opens through explorer: shell:AppsFolder\<id>
        if (background) info.WindowStyle = ProcessWindowStyle.Minimized; // most apps honour it, and a minimized window takes nothing
        Process started = Process.Start(info);
        // Not waited for: an app reports ready seconds after its window exists. The caller watches `windows` instead.
        return "{\"pid\":" + (started == null ? 0 : started.Id) + ",\"foreground\":" + before.ToInt64() + "}";
    }

    /** Shown, but under every other window and without the focus: a minimized window paints nothing for PrintWindow, a raised one takes the user's screen. */
    static string Behind(IntPtr hwnd, IntPtr user)
    {
        // `user` is the window that was in front before the launch: an app that starts minimized can still come up with the focus.
        IntPtr before = user != IntPtr.Zero ? user : GetForegroundWindow();
        ShowWindow(hwnd, 4 /* SW_SHOWNOACTIVATE */);
        SetWindowPos(hwnd, new IntPtr(1) /* HWND_BOTTOM */, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 /* NOSIZE | NOMOVE | NOACTIVATE */);
        bool took = before != IntPtr.Zero && GetForegroundWindow() != before;
        if (took) SetForegroundWindow(before);
        return "{\"ok\":true,\"tookFocus\":" + Bool(took) + "}";
    }

    static string Key(IntPtr hwnd, int vk, string modifiers)
    {
        // Posted to the window, so it goes there whatever has the focus. Chromium ignores posted keys: a page is worked
        // through its controls and the DevTools port instead.
        foreach (string m in modifiers.Split(new[] { '+' }, StringSplitOptions.RemoveEmptyEntries)) PostMessage(hwnd, 0x0100, new IntPtr(Modifier(m)), IntPtr.Zero);
        PostMessage(hwnd, 0x0100 /* WM_KEYDOWN */, new IntPtr(vk), IntPtr.Zero);
        PostMessage(hwnd, 0x0101 /* WM_KEYUP */, new IntPtr(vk), new IntPtr(unchecked((int)0xC0000001)));
        foreach (string m in modifiers.Split(new[] { '+' }, StringSplitOptions.RemoveEmptyEntries)) PostMessage(hwnd, 0x0101, new IntPtr(Modifier(m)), new IntPtr(unchecked((int)0xC0000001)));
        return "{\"ok\":true}";
    }

    static int Modifier(string name) { return name == "control" || name == "ctrl" || name == "command" ? 0x11 : name == "shift" ? 0x10 : name == "option" || name == "alt" ? 0x12 : 0x5B; }

    /**
     * pointer <hwnd> <count> x y [x y ...]: a press, a path and a release posted to one window, from screen pixels. The
     * user's cursor does not move. A classic control is a window of its own and reads only its own messages, so the
     * stroke goes to the deepest child under its first point. Chromium and XAML read the real pointer and ignore these.
     */
    static string Pointer(IntPtr hwnd, string[] a)
    {
        int count = Int(a[2]);
        POINT start; start.X = Int(a[3]); start.Y = Int(a[4]);
        IntPtr target = hwnd;
        for (int depth = 0; depth < 8; depth++)
        {
            POINT local = start;
            ScreenToClient(target, ref local);
            IntPtr child = ChildWindowFromPointEx(target, local, 0x0001 | 0x0002 /* SKIPINVISIBLE | SKIPDISABLED */);
            if (child == IntPtr.Zero || child == target) break;
            target = child;
        }
        hwnd = target;
        for (int click = 0; click < count; click++)
        {
            for (int i = 3; i + 1 < a.Length; i += 2)
            {
                POINT p; p.X = Int(a[i]); p.Y = Int(a[i + 1]);
                ScreenToClient(hwnd, ref p);
                IntPtr at = new IntPtr((p.Y << 16) | (p.X & 0xFFFF));
                if (i == 3) { PostMessage(hwnd, 0x0200 /* WM_MOUSEMOVE */, IntPtr.Zero, at); PostMessage(hwnd, 0x0201 /* WM_LBUTTONDOWN */, new IntPtr(1), at); }
                else PostMessage(hwnd, 0x0200, new IntPtr(1), at);
                if (i + 3 >= a.Length) PostMessage(hwnd, 0x0202 /* WM_LBUTTONUP */, IntPtr.Zero, at);
            }
        }
        return "{\"ok\":true}";
    }

    /** The seat: the real pointer and keyboard, for the default mode where the agent has the machine to itself. */
    static string Input(string[] a)
    {
        List<INPUT> events = new List<INPUT>();
        if (a[1] == "move") SetCursorPos(Int(a[2]), Int(a[3]));
        else if (a[1] == "click")
        {
            SetCursorPos(Int(a[2]), Int(a[3]));
            bool right = a[4] == "right";
            for (int i = 0; i < Int(a[5]); i++) { events.Add(Mouse(right ? 0x0008u : 0x0002u, 0)); events.Add(Mouse(right ? 0x0010u : 0x0004u, 0)); }
        }
        else if (a[1] == "drag")
        {
            SetCursorPos(Int(a[2]), Int(a[3]));
            SendInput(1, new[] { Mouse(0x0002, 0) }, Marshal.SizeOf(typeof(INPUT)));
            for (int i = 4; i + 1 < a.Length; i += 2) { SetCursorPos(Int(a[i]), Int(a[i + 1])); System.Threading.Thread.Sleep(12); }
            events.Add(Mouse(0x0004, 0));
        }
        else if (a[1] == "scroll") { SetCursorPos(Int(a[2]), Int(a[3])); events.Add(Mouse(0x0800 /* WHEEL */, Int(a[4]) * 120)); if (Int(a[5]) != 0) events.Add(Mouse(0x1000 /* HWHEEL */, Int(a[5]) * 120)); }
        else if (a[1] == "type") foreach (char c in Text(a[2])) { events.Add(Keyboard(0, c, 0x0004 /* UNICODE */)); events.Add(Keyboard(0, c, 0x0004 | 0x0002)); }
        else if (a[1] == "key")
        {
            string[] modifiers = a.Length > 3 ? a[3].Split(new[] { '+' }, StringSplitOptions.RemoveEmptyEntries) : new string[0];
            foreach (string m in modifiers) events.Add(Keyboard((ushort)Modifier(m), '\0', 0));
            events.Add(Keyboard((ushort)Int(a[2]), '\0', 0)); events.Add(Keyboard((ushort)Int(a[2]), '\0', 0x0002 /* KEYUP */));
            foreach (string m in modifiers) events.Add(Keyboard((ushort)Modifier(m), '\0', 0x0002));
        }
        if (events.Count > 0) SendInput((uint)events.Count, events.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        return "{\"ok\":true}";
    }

    static INPUT Mouse(uint flags, int data) { INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = unchecked((uint)data); return i; }
    static INPUT Keyboard(ushort vk, char c, uint flags) { INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = c; i.u.ki.dwFlags = flags; return i; }

    // ---------------------------------------------------------------- devtools: the browser's socket, a line per message

    /**
     * devtools <port>: one socket to the browser on 127.0.0.1:port, held until stdin closes. A line in is one message for
     * Chrome, sent as it is; a message from Chrome is one line out. WSL has a loopback of its own, so the port is out of
     * its reach, and this side is where Chrome is either way. A relay, not a client: the JSON is composed and read in
     * devtools.ts. The first line out is Chrome's own /json/version, which says the socket is open. The one line this
     * writes itself is the last, `{"error":"..."}`: nothing listens, or Chrome went. Loopback only.
     */
    static int Devtools(int port)
    {
        Stream output = Console.OpenStandardOutput();
        System.Net.WebSockets.ClientWebSocket socket = new System.Net.WebSockets.ClientWebSocket();
        try
        {
            string version;
            try
            {
                // Windows retries a refused connection for two seconds before it says so. On loopback, not open at once is not open.
                using (System.Net.Sockets.TcpClient probe = new System.Net.Sockets.TcpClient())
                    if (!probe.BeginConnect("127.0.0.1", port, null, null).AsyncWaitHandle.WaitOne(400) || !probe.Connected) throw new System.Net.WebException("refused");
                System.Net.HttpWebRequest request = (System.Net.HttpWebRequest)System.Net.WebRequest.Create("http://127.0.0.1:" + port + "/json/version");
                request.Proxy = null; // or the system proxy is asked about loopback first, which costs seconds
                request.Timeout = 3000;
                using (System.Net.WebResponse response = request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                    version = reader.ReadToEnd().Replace("\r", "").Replace("\n", " ");
            }
            catch (System.Net.WebException) { throw new Exception("nothing listens on DevTools port " + port); }
            System.Text.RegularExpressions.Match path = System.Text.RegularExpressions.Regex.Match(version, "\"webSocketDebuggerUrl\"\\s*:\\s*\"ws://[^/\"]+(/[^\"]*)\"");
            if (!path.Success) throw new Exception("port " + port + " is not a browser's DevTools port");
            socket.Options.SetBuffer(65536, 65536);
            socket.Options.KeepAliveInterval = TimeSpan.Zero; // Chrome sends no pongs back and needs none
            // The host is ours, not the one Chrome printed: whatever it says, this connects to loopback.
            socket.ConnectAsync(new Uri("ws://127.0.0.1:" + port + path.Groups[1].Value), new CancellationTokenSource(5000).Token).Wait();
            Line(output, Encoding.UTF8.GetBytes(version), -1);

            Thread up = new Thread(delegate ()
            {
                try
                {
                    StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), false, 65536);
                    for (string line = input.ReadLine(); line != null; line = input.ReadLine())
                        if (line.Length > 0) socket.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(line)), System.Net.WebSockets.WebSocketMessageType.Text, true, CancellationToken.None).Wait();
                }
                catch (Exception) { /* a closed handle or a closed socket: the loop below has the same news */ }
                stop = true;
                socket.Abort();
            });
            up.IsBackground = true;
            up.Start();

            byte[] buffer = new byte[262144];
            MemoryStream whole = new MemoryStream();
            for (;;)
            {
                // A message comes in frames, and one with a page's elements or a screenshot is megabytes of them.
                System.Net.WebSockets.WebSocketReceiveResult part = socket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None).Result;
                if (part.MessageType == System.Net.WebSockets.WebSocketMessageType.Close) throw new Exception("the browser closed its DevTools socket");
                whole.Write(buffer, 0, part.Count);
                if (!part.EndOfMessage) continue;
                Line(output, whole.GetBuffer(), (int)whole.Length);
                whole.SetLength(0);
            }
        }
        catch (Exception e)
        {
            if (stop) return 0; // stdin closed: the caller is done, and that is not an error
            while (e.InnerException != null) e = e.InnerException;
            string said = e is System.Net.WebSockets.WebSocketException || e is IOException || e is ObjectDisposedException ? "the browser closed its DevTools socket" : e.Message;
            try { Line(output, Encoding.UTF8.GetBytes("{\"error\":" + Quote(said) + "}"), -1); } catch (Exception) { /* nobody is reading */ }
            return 1;
        }
    }

    /** One message as exactly one line. Compact JSON has no newline in it, and one between tokens is a space all the same. */
    static void Line(Stream output, byte[] bytes, int length)
    {
        if (length < 0) length = bytes.Length;
        for (int i = 0; i < length; i++) if (bytes[i] == 10 || bytes[i] == 13) bytes[i] = 32;
        output.Write(bytes, 0, length);
        output.WriteByte(10);
        output.Flush();
    }

    // ---------------------------------------------------------------- voice: the two modes that stay running

    static volatile bool stop;

    /** The way out of a streaming mode is its stdin closing: a signal does not cross WSL interop, and a parent that dies closes it too. */
    static void WatchStdin()
    {
        Thread watcher = new Thread(delegate ()
        {
            try { Stream input = Console.OpenStandardInput(); byte[] buffer = new byte[64]; while (input.Read(buffer, 0, buffer.Length) > 0) { } }
            catch (Exception) { /* a closed handle is the same news */ }
            stop = true;
        });
        watcher.IsBackground = true;
        watcher.Start();
    }

    [StructLayout(LayoutKind.Sequential)] struct WAVEFORMATEX { public ushort wFormatTag, nChannels; public uint nSamplesPerSec, nAvgBytesPerSec; public ushort nBlockAlign, wBitsPerSample, cbSize; }
    [StructLayout(LayoutKind.Sequential)] struct WAVEHDR { public IntPtr lpData; public uint dwBufferLength, dwBytesRecorded; public IntPtr dwUser; public uint dwFlags, dwLoops; public IntPtr lpNext, reserved; }

    [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr handle, uint device, ref WAVEFORMATEX format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern int waveInStart(IntPtr handle);
    [DllImport("winmm.dll")] static extern int waveInReset(IntPtr handle);
    [DllImport("winmm.dll")] static extern int waveInClose(IntPtr handle);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);

    /** The default microphone as mono 24 kHz signed 16-bit PCM on stdout, which is the format the transcriber takes as it comes. */
    static int Mic()
    {
        WAVEFORMATEX format = new WAVEFORMATEX();
        format.wFormatTag = 1; format.nChannels = 1; format.nSamplesPerSec = 24000;
        format.wBitsPerSample = 16; format.nBlockAlign = 2; format.nAvgBytesPerSec = 48000;
        IntPtr handle;
        // WAVE_MAPPER: whatever input the user chose in Windows, resampled to this format by Windows.
        int opened = waveInOpen(out handle, 0xFFFFFFFF, ref format, IntPtr.Zero, IntPtr.Zero, 0);
        if (opened != 0) throw new Exception("no usable microphone (waveInOpen " + opened + "): check Settings > Privacy & security > Microphone");
        const int count = 8, bytes = 2400; // 50 ms each, so a word is on its way while it is still being said
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
        int next = 0; // buffers complete in the order they were queued
        try
        {
            while (!stop)
            {
                WAVEHDR header = (WAVEHDR)Marshal.PtrToStructure(headers[next], typeof(WAVEHDR));
                if ((header.dwFlags & 1 /* WHDR_DONE */) == 0) { Thread.Sleep(5); continue; }
                int recorded = (int)header.dwBytesRecorded;
                if (recorded > 0) { Marshal.Copy(header.lpData, chunk, 0, recorded); output.Write(chunk, 0, recorded); output.Flush(); }
                waveInUnprepareHeader(handle, headers[next], headerSize);
                header.dwFlags = 0; header.dwBytesRecorded = 0;
                Marshal.StructureToPtr(header, headers[next], false);
                waveInPrepareHeader(handle, headers[next], headerSize);
                waveInAddBuffer(handle, headers[next], headerSize);
                next = (next + 1) % count;
            }
        }
        catch (IOException) { /* the reader went away */ }
        waveInReset(handle);
        waveInClose(handle);
        return 0;
    }

    /**
     * `down` and `up` for one held key, and `cancel` for Ctrl+Alt+Esc, a line each. The key is watched, not registered:
     * RegisterHotKey reports a press and never the release, and a hold is the whole gesture. So the key still reaches
     * the app in front, which is why the default is one few apps bind.
     */
    static int Hotkey(int vk)
    {
        bool down = false, cancelling = false;
        while (!stop)
        {
            bool now = Held(vk);
            if (now != down) { down = now; Console.Out.WriteLine(down ? "down" : "up"); Console.Out.Flush(); }
            bool cancel = Held(0x11 /* CONTROL */) && Held(0x12 /* ALT */) && Held(0x1B /* ESCAPE */);
            if (cancel && !cancelling) { Console.Out.WriteLine("cancel"); Console.Out.Flush(); }
            cancelling = cancel;
            Thread.Sleep(15);
        }
        return 0;
    }

    static bool Held(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    // ---------------------------------------------------------------- small things

    static IntPtr Handle(string s) { return new IntPtr(long.Parse(s, CultureInfo.InvariantCulture)); }
    static int Int(string s) { return (int)Math.Round(double.Parse(s, CultureInfo.InvariantCulture)); }
    static string Text(string base64) { return Encoding.UTF8.GetString(Convert.FromBase64String(base64)); }
    static string Bool(bool b) { return b ? "true" : "false"; }
    static string Num(double d) { return double.IsNaN(d) || double.IsInfinity(d) ? "0" : Math.Round(d).ToString(CultureInfo.InvariantCulture); }
    static string TextOf(IntPtr hwnd) { StringBuilder b = new StringBuilder(512); GetWindowText(hwnd, b, 512); return b.ToString(); }
    static string ClassOf(IntPtr hwnd) { StringBuilder b = new StringBuilder(256); GetClassName(hwnd, b, 256); return b.ToString(); }
    static string Clean(string s) { return s == null ? "" : (s.Length > 200 ? s.Substring(0, 200) : s).Replace('\r', ' ').Replace('\n', ' ').Trim(); }
    static bool Flag(AutomationElement el, AutomationProperty property) { object v = el.GetCachedPropertyValue(property, true); return v is bool && (bool)v; }

    static string Quote(string s)
    {
        StringBuilder b = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }
}
