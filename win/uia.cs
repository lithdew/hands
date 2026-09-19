// uia.cs — what the DOM is to the hand's browser, for every other window: UI Automation.
//
// A line in, a line out, like helper.cs, but in a process of its own: an application that stops
// answering UI Automation must not hold up window state, capture or the other hands.
//
//   tree <hwnd> [max]            the window's controls as JSON, read in ONE cached request (a walk that asks
//                                property by property crosses the process boundary hundreds of times)
//   act <hwnd> <n> <verb>        invoke | toggle | select | expand | collapse, on element n of the last tree.
//                                These are patterns: no pointer, no focus, so they work on a hidden desktop.
//   set <hwnd> <n> <base64|->    put text in a field; - empties it
//   awake <hwnd> | asleep <hwnd>  keep a UWP application running while hidden (Windows suspends it otherwise), or give it back
//   keys <hwnd> <base64>         post characters to a window's queue (a hidden UWP window cannot be read, but it can be typed to)
//
// Nothing here filters on IsOffscreen: every control of a window on another virtual desktop is "offscreen".
//
// Built by win/uia.ts with the C# 5 compiler that ships in Windows, so: no interpolation, no ?., no out var.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Automation;

static class PukUia
{
    /** Elements of the last tree of each window. `act` and `set` name one by its position. */
    static readonly Dictionary<long, List<AutomationElement>> last = new Dictionary<long, List<AutomationElement>>();
    /** A pattern call on a Win32 button returns only when the dialog it opened has closed. Nobody waits for that. */
    const int ActTimeoutMs = 1500;

    static void Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = new UTF8Encoding(false);
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            string reply;
            try { reply = Handle(line.Trim()); }
            catch (Exception e) { reply = "error " + OneLine(e.GetType().Name + ": " + e.Message); }
            Console.Out.WriteLine(reply);
            Console.Out.Flush();
        }
    }

    static string Handle(string line)
    {
        string[] p = line.Split(new[] { ' ' }, 4, StringSplitOptions.RemoveEmptyEntries);
        if (p.Length == 0) return "error empty request";
        if (p[0] == "ping") return "pong";
        if (p.Length < 2) return "error usage: tree <hwnd> [max] | act <hwnd> <n> <verb> | set <hwnd> <n> <base64>";
        long hwnd = long.Parse(p[1], CultureInfo.InvariantCulture);
        if (p[0] == "diag") return Diag(hwnd);
        if (p[0] == "awake" || p[0] == "asleep") return Awake(new IntPtr(hwnd), p[0] == "awake");
        if (p[0] == "keys") return p.Length < 3 ? "error usage: keys <hwnd> <base64>" : Keys(new IntPtr(hwnd), Encoding.UTF8.GetString(Convert.FromBase64String(p[2])));
        if (p[0] == "tree") return Tree(hwnd, p.Length > 2 ? int.Parse(p[2], CultureInfo.InvariantCulture) : 400);
        if (p.Length < 4) return "error usage: act <hwnd> <n> <verb> | set <hwnd> <n> <base64>";
        List<AutomationElement> elements;
        int n = int.Parse(p[2], CultureInfo.InvariantCulture);
        if (!last.TryGetValue(hwnd, out elements) || n < 0 || n >= elements.Count) return "error no such element; read the tree again";
        AutomationElement el = elements[n];
        if (p[0] == "act") return Act(el, p[3]);
        if (p[0] == "set") return Set(el, p[3] == "-" ? "" : Encoding.UTF8.GetString(Convert.FromBase64String(p[3])));
        return "error unknown request";
    }

    // ---------------------------------------------------------------- awake

    // Measured: a UWP application on a desktop nobody is looking at is SUSPENDED by Windows within seconds (Calculator:
    // every thread "Suspended", Responding = false). A frozen process serves no UI Automation (one node), reads no
    // keys, and reacts to no click, which is why the vision agent looped on it. This is the switch debuggers use to
    // keep a package running; `asleep` hands it back to Windows.
    [System.Runtime.InteropServices.ComImport, System.Runtime.InteropServices.Guid("B1AEC16F-2383-4852-B0E9-8F0B1DC66B4D")] class PackageDebugSettings { }
    [System.Runtime.InteropServices.ComImport, System.Runtime.InteropServices.Guid("F27C3930-8029-4AD1-94E3-3DBA417810C1"), System.Runtime.InteropServices.InterfaceType(System.Runtime.InteropServices.ComInterfaceType.InterfaceIsIUnknown)]
    interface IPackageDebugSettings
    {
        [System.Runtime.InteropServices.PreserveSig] int EnableDebugging([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string package, [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string debugger, IntPtr environment);
        [System.Runtime.InteropServices.PreserveSig] int DisableDebugging([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string package);
        [System.Runtime.InteropServices.PreserveSig] int Suspend([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string package);
        [System.Runtime.InteropServices.PreserveSig] int Resume([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string package);
    }
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);

    static string PackageOf(IntPtr hwnd)
    {
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        IntPtr process = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (process == IntPtr.Zero) return "";
        try { uint length = 512; StringBuilder name = new StringBuilder(512); return GetPackageFullName(process, ref length, name) == 0 ? name.ToString() : ""; }
        finally { CloseHandle(process); }
    }

    /** Keep the window's package awake while hidden, or give it back. "none" when the window is not a packaged UWP application. */
    static string Awake(IntPtr hwnd, bool on)
    {
        string package = PackageOf(hwnd);
        if (package.Length == 0 || ClassOf(hwnd) != "Windows.UI.Core.CoreWindow")
        {
            // Given the frame: the content is the detached CoreWindow with the same title.
            string title = TitleOf(hwnd); IntPtr core = IntPtr.Zero;
            EnumWindows(delegate (IntPtr top, IntPtr l) { if (core == IntPtr.Zero && ClassOf(top) == "Windows.UI.Core.CoreWindow" && TitleOf(top) == title && PackageOf(top).Length > 0) core = top; return true; }, IntPtr.Zero);
            if (core == IntPtr.Zero && ClassOf(hwnd) != "Windows.UI.Core.CoreWindow") return "none";
            if (core != IntPtr.Zero) package = PackageOf(core);
        }
        if (package.Length == 0) return "none";
        IPackageDebugSettings settings = (IPackageDebugSettings)new PackageDebugSettings();
        int hr = on ? settings.EnableDebugging(package, null, IntPtr.Zero) : settings.DisableDebugging(package);
        if (hr == 0 && on) settings.Resume(package);
        return hr == 0 ? "ok " + package : "error 0x" + hr.ToString("x8") + " " + package;
    }

    // ---------------------------------------------------------------- diag

    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);
    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    static string ClassOf(IntPtr hwnd) { StringBuilder b = new StringBuilder(256); GetClassName(hwnd, b, 256); return b.ToString(); }
    static string TitleOf(IntPtr hwnd) { StringBuilder b = new StringBuilder(512); GetWindowText(hwnd, b, 512); return b.ToString(); }

    static int Count(IntPtr hwnd, Condition view)
    {
        try
        {
            CacheRequest request = new CacheRequest();
            request.Add(AutomationElement.NameProperty);
            request.TreeScope = TreeScope.Element | TreeScope.Descendants;
            request.TreeFilter = view;
            request.AutomationElementMode = AutomationElementMode.None;
            AutomationElement root;
            using (request.Activate()) root = AutomationElement.FromHandle(hwnd);
            int n = 0; CountWalk(root, ref n); return n;
        }
        catch (Exception) { return -1; }
    }
    static void CountWalk(AutomationElement el, ref int n) { n++; foreach (AutomationElement child in el.CachedChildren) CountWalk(child, ref n); }

    /** Where is this window's content? Its class, its child windows, and any detached CoreWindow with the same title, each with its node counts. */
    static string Diag(long hwnd)
    {
        IntPtr frame = new IntPtr(hwnd);
        string title = TitleOf(frame);
        StringBuilder o = new StringBuilder();
        uint pid; GetWindowThreadProcessId(frame, out pid);
        o.Append("frame ").Append(hwnd).Append(" class=").Append(ClassOf(frame)).Append(" pid=").Append(pid).Append(" control=").Append(Count(frame, Automation.ControlViewCondition)).Append(" raw=").Append(Count(frame, Automation.RawViewCondition));
        EnumChildWindows(frame, delegate (IntPtr child, IntPtr l) { uint cp; GetWindowThreadProcessId(child, out cp); o.Append(" | child ").Append(child.ToInt64()).Append(" class=").Append(ClassOf(child)).Append(" pid=").Append(cp).Append(" control=").Append(Count(child, Automation.ControlViewCondition)); return true; }, IntPtr.Zero);
        EnumWindows(delegate (IntPtr top, IntPtr l) {
            if (top != frame && ClassOf(top) == "Windows.UI.Core.CoreWindow" && TitleOf(top) == title) { uint tp; GetWindowThreadProcessId(top, out tp); o.Append(" | detached core ").Append(top.ToInt64()).Append(" pid=").Append(tp).Append(" control=").Append(Count(top, Automation.ControlViewCondition)); }
            return true; }, IntPtr.Zero);
        return o.ToString();
    }

    // ---------------------------------------------------------------- tree

    static readonly AutomationProperty[] Wanted = {
        AutomationElement.RuntimeIdProperty, AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.LocalizedControlTypeProperty, AutomationElement.BoundingRectangleProperty,
        AutomationElement.IsEnabledProperty, AutomationElement.HasKeyboardFocusProperty, AutomationElement.IsPasswordProperty, AutomationElement.AutomationIdProperty,
        AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty, AutomationElement.IsTogglePatternAvailableProperty,
        AutomationElement.IsSelectionItemPatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty, AutomationElement.IsTextPatternAvailableProperty,
        ValuePattern.ValueProperty, ValuePattern.IsReadOnlyProperty, TogglePattern.ToggleStateProperty, SelectionItemPattern.IsSelectedProperty, ExpandCollapsePattern.ExpandCollapseStateProperty,
    };

    static string Tree(long hwnd, int max)
    {
        Stopwatch clock = Stopwatch.StartNew();
        CacheRequest request = new CacheRequest();
        foreach (AutomationProperty property in Wanted) request.Add(property);
        request.TreeScope = TreeScope.Element | TreeScope.Descendants;
        request.TreeFilter = Automation.ControlViewCondition;
        request.AutomationElementMode = AutomationElementMode.Full; // live references: `act` needs them
        AutomationElement root;
        using (request.Activate()) root = AutomationElement.FromHandle(new IntPtr(hwnd));

        List<AutomationElement> kept = new List<AutomationElement>();
        List<string> texts = new List<string>();
        HashSet<string> visited = new HashSet<string>();
        StringBuilder json = new StringBuilder("{\"elements\":[");
        Rect frame = (Rect)root.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
        int seen = 0;
        Walk(root, "", frame, kept, texts, json, max, ref seen, visited);
        // Measured on Windows 11: for a window on another virtual desktop the tree under the top-level handle stops at
        // the title bar (Paint: 7 nodes), while the content's own child windows, the WinUI islands and the classic
        // controls, still answer (Paint: 84 controls). So each child window is read as a root too, and what was already
        // seen is skipped. A UWP CoreWindow has no such children and stays closed.
        List<IntPtr> children = new List<IntPtr>();
        EnumChildWindows(new IntPtr(hwnd), delegate (IntPtr child, IntPtr l) { children.Add(child); return true; }, IntPtr.Zero);
        // A UWP application is two windows: the frame, and its content in a CoreWindow of the same title that is detached
        // from the frame while hidden. Whichever one was asked for, the content is what there is to read.
        if (ClassOf(new IntPtr(hwnd)) == "ApplicationFrameWindow")
        {
            string title = TitleOf(new IntPtr(hwnd));
            EnumWindows(delegate (IntPtr top, IntPtr l) { if (ClassOf(top) == "Windows.UI.Core.CoreWindow" && TitleOf(top) == title) children.Add(top); return true; }, IntPtr.Zero);
        }
        foreach (IntPtr child in children)
        {
            if (kept.Count >= max) break;
            try
            {
                AutomationElement island;
                using (request.Activate()) island = AutomationElement.FromHandle(child);
                Walk(island, "", frame, kept, texts, json, max, ref seen, visited);
            }
            catch (Exception) { /* a child window that went away, or one with no provider */ }
        }
        last[hwnd] = kept;
        json.Append("],\"texts\":[");
        for (int i = 0; i < texts.Count && i < 40; i++) { if (i > 0) json.Append(','); Quote(json, texts[i]); }
        json.Append("],\"frame\":[").Append(Num(frame.X)).Append(',').Append(Num(frame.Y)).Append(',').Append(Num(frame.Width)).Append(',').Append(Num(frame.Height));
        json.Append("],\"seen\":").Append(seen).Append(",\"ms\":").Append(clock.ElapsedMilliseconds).Append('}');
        return json.ToString();
    }

    static void Walk(AutomationElement el, string within, Rect frame, List<AutomationElement> kept, List<string> texts, StringBuilder json, int max, ref int seen, HashSet<string> visited, bool inMenuBar = false)
    {
        int[] runtime = el.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty) as int[];
        if (runtime != null && !visited.Add(string.Join(".", Array.ConvertAll(runtime, delegate (int i) { return i.ToString(CultureInfo.InvariantCulture); })))) return;
        seen++;
        ControlType type = el.GetCachedPropertyValue(AutomationElement.ControlTypeProperty) as ControlType;
        string name = Clean(el.GetCachedPropertyValue(AutomationElement.NameProperty) as string);
        object box = el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
        Rect rect = box is Rect ? (Rect)box : Rect.Empty;
        bool placed = !rect.IsEmpty && rect.Width >= 2 && rect.Height >= 2 && !double.IsInfinity(rect.Width);

        if (type == ControlType.Text) { if (name.Length > 0 && texts.Count < 40) texts.Add(name); }
        else if (placed && kept.Count < max && Actionable(el, type))
        {
            bool invoke = Flag(el, AutomationElement.IsInvokePatternAvailableProperty), toggle = Flag(el, AutomationElement.IsTogglePatternAvailableProperty);
            bool select = Flag(el, AutomationElement.IsSelectionItemPatternAvailableProperty), expand = Flag(el, AutomationElement.IsExpandCollapsePatternAvailableProperty);
            bool hasValue = Flag(el, AutomationElement.IsValuePatternAvailableProperty), password = Flag(el, AutomationElement.IsPasswordProperty);
            bool readOnly = hasValue && Flag(el, ValuePattern.IsReadOnlyProperty);
            bool editable = (type == ControlType.Edit || type == ControlType.Document || (type == ControlType.ComboBox && hasValue)) && !readOnly;
            string value = hasValue && !password ? Clean(el.GetCachedPropertyValue(ValuePattern.ValueProperty) as string) : "";
            if (toggle) { object state = el.GetCachedPropertyValue(TogglePattern.ToggleStateProperty); if (state is ToggleState) value = (ToggleState)state == ToggleState.On ? "on" : "off"; }
            if (select && Flag(el, SelectionItemPattern.IsSelectedProperty)) value = "selected";
            if (name.Length > 0 || editable)
            {
                if (kept.Count > 0) json.Append(',');
                // "File" in a menu bar is always there; a "menu item" is what an open menu holds, and an open menu wants an answer first.
                string role = inMenuBar && type == ControlType.MenuItem ? "menu" : Clean(el.GetCachedPropertyValue(AutomationElement.LocalizedControlTypeProperty) as string);
                json.Append("{\"n\":").Append(kept.Count).Append(",\"role\":"); Quote(json, role);
                json.Append(",\"name\":"); Quote(json, name);
                json.Append(",\"value\":"); Quote(json, value);
                json.Append(",\"within\":"); Quote(json, within);
                json.Append(",\"editable\":").Append(editable ? "true" : "false");
                json.Append(",\"setValue\":").Append(hasValue && !readOnly ? "true" : "false");
                json.Append(",\"focused\":").Append(Flag(el, AutomationElement.HasKeyboardFocusProperty) ? "true" : "false");
                json.Append(",\"enabled\":").Append(Flag(el, AutomationElement.IsEnabledProperty) ? "true" : "false");
                json.Append(",\"can\":\"").Append(invoke ? "invoke" : toggle ? "toggle" : select ? "select" : expand ? "expand" : "").Append('"');
                json.Append(",\"rect\":[").Append(Num(rect.X - frame.X)).Append(',').Append(Num(rect.Y - frame.Y)).Append(',').Append(Num(rect.Width)).Append(',').Append(Num(rect.Height)).Append("]}");
                kept.Add(el);
            }
        }

        // The nearest named box is what tells two "OK" buttons apart, as a form or dialog does on a page.
        bool container = type == ControlType.Group || type == ControlType.Pane || type == ControlType.ToolBar || type == ControlType.Menu || type == ControlType.MenuBar
            || type == ControlType.Tab || type == ControlType.List || type == ControlType.Tree || type == ControlType.Window || type == ControlType.Custom;
        string inside = container && name.Length > 0 ? name : within;
        foreach (AutomationElement child in el.CachedChildren) Walk(child, inside, frame, kept, texts, json, max, ref seen, visited, type == ControlType.MenuBar);
    }

    static bool Actionable(AutomationElement el, ControlType type)
    {
        if (type == ControlType.Button || type == ControlType.Edit || type == ControlType.Document || type == ControlType.CheckBox || type == ControlType.RadioButton || type == ControlType.ComboBox
            || type == ControlType.ListItem || type == ControlType.MenuItem || type == ControlType.TabItem || type == ControlType.Hyperlink || type == ControlType.SplitButton
            || type == ControlType.TreeItem || type == ControlType.DataItem || type == ControlType.Slider || type == ControlType.Spinner) return true;
        return Flag(el, AutomationElement.IsInvokePatternAvailableProperty);
    }

    // ---------------------------------------------------------------- act

    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, string lParam);

    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    /** Characters posted to a window's own queue, one by one: what a keyboard sends, minus the focus. For windows UI Automation
     * cannot read while hidden (a UWP CoreWindow), whose applications still take typed input: Calculator reads "12*31=". */
    static string Keys(IntPtr window, string text)
    {
        IntPtr before = GetForegroundWindow();
        foreach (char c in text) { PostMessage(window, 0x0102 /* WM_CHAR */, new IntPtr(c), new IntPtr(1)); Thread.Sleep(35); }
        return GetForegroundWindow() != before ? "ok took-focus" : "ok";
    }

    /** "ok", or "ok took-focus" when the user's foreground window changed under the call: win/uia.ts then puts it back. */
    static string Watched(Work work)
    {
        IntPtr before = GetForegroundWindow();
        string result = work();
        return result == "ok" && GetForegroundWindow() != before ? "ok took-focus" : result;
    }

    static string Act(AutomationElement el, string verb)
    {
        return Timed(delegate
        {
          return Watched(delegate
          {
            object pattern;
            if (verb == "invoke" && el.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); return "ok"; }
            if (verb == "toggle" && el.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { ((TogglePattern)pattern).Toggle(); return "ok"; }
            if (verb == "select" && el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) { ((SelectionItemPattern)pattern).Select(); return "ok"; }
            if (verb == "expand" && el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) { ((ExpandCollapsePattern)pattern).Expand(); return "ok"; }
            if (verb == "collapse" && el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) { ((ExpandCollapsePattern)pattern).Collapse(); return "ok"; }
            return "error the element does not support " + verb;
          });
        });
    }

    static string Set(AutomationElement el, string text)
    {
        return Timed(delegate
        {
          return Watched(delegate
          {
            // Measured: ValuePattern.SetValue on a classic edit control gives it the keyboard focus first. That activates
            // the hidden window, and Windows follows the focus onto the hand's desktop: the user's screen flips. An edit
            // control with a window of its own takes its text as a message instead: select all, replace the selection.
            // That is what typing does (change notifications, undo), and no focus is involved.
            object handle = el.GetCurrentPropertyValue(AutomationElement.NativeWindowHandleProperty, true);
            IntPtr window = handle is int && (int)handle != 0 ? new IntPtr((int)handle) : IntPtr.Zero;
            string kind = window != IntPtr.Zero ? ClassOf(window) : "";
            if (kind == "Edit" || kind.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase))
            {
                SendMessage(window, 0x00B1 /* EM_SETSEL */, IntPtr.Zero, new IntPtr(-1));
                SendMessage(window, 0x00C2 /* EM_REPLACESEL */, new IntPtr(1), text);
                return "ok";
            }
            object pattern;
            if (!el.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return "error the element takes no value";
            ((ValuePattern)pattern).SetValue(text);
            return "ok";
          });
        });
    }

    delegate string Work();
    static string Timed(Work work)
    {
        string result = null;
        Exception failure = null;
        Thread thread = new Thread(delegate () { try { result = work(); } catch (Exception e) { failure = e; } });
        thread.IsBackground = true;
        thread.Start();
        if (!thread.Join(ActTimeoutMs)) return "pending"; // it opened something modal and is waiting for it; the next look will show what
        if (failure != null) return "error " + OneLine(failure.GetType().Name + ": " + failure.Message);
        return result;
    }

    // ---------------------------------------------------------------- words

    static bool Flag(AutomationElement el, AutomationProperty property)
    {
        object value = el.GetCachedPropertyValue(property, true);
        return value is bool && (bool)value;
    }

    static string Clean(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        StringBuilder b = new StringBuilder();
        bool space = false;
        foreach (char c in s) { if (char.IsWhiteSpace(c) || char.IsControl(c)) { space = b.Length > 0; continue; } if (space) b.Append(' '); space = false; b.Append(c); if (b.Length >= 120) break; }
        return b.ToString();
    }

    static string OneLine(string s) { return Clean(s); }
    static string Num(double d) { return double.IsNaN(d) || double.IsInfinity(d) ? "0" : Math.Round(d).ToString(CultureInfo.InvariantCulture); }

    static void Quote(StringBuilder json, string s)
    {
        json.Append('"');
        foreach (char c in s ?? "")
        {
            if (c == '"' || c == '\\') json.Append('\\').Append(c);
            else if (c < 0x20) json.Append("\\u").Append(((int)c).ToString("x4"));
            else json.Append(c);
        }
        json.Append('"');
    }
}
