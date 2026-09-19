// The native half of feed.ts: what the user sees while hands work. One more mode of the helper, `feed`, which stays
// running like `mic` and `hotkey`: command lines on stdin, a few report lines on stdout, gone when stdin closes.
//
// Three kinds of window, and none of them can take the focus, the pointer, or a click meant for something else:
//   - a tile per hand in the corner of the screen: a live DWM thumbnail of the hand's window. The thumbnail is the
//     compositor's own picture, so it costs nothing, runs at the screen's rate, and shows a window that is covered
//     or on another virtual desktop. It dies with a minimized window, which is why a hand's window is kept behind
//     the user's and never minimized.
//   - an overlay exactly over each tile's well, where the hand's pointer is drawn. It has to be a window of its
//     own: DWM composes a thumbnail over anything its own window paints. Layered, so it has per-pixel alpha, and
//     WS_EX_TRANSPARENT, so every click falls through it.
//   - the card along the bottom of the screen: the words while the key is held, then a row per hand with the
//     narrator's line, and the question when a hand wants to do something sensitive.
//
// This file only draws. When a pointer moves, how fast, where a ripple starts and what colour a state is are all
// decided in TypeScript (timeline.ts, paint.ts), where they are tested; `draw` replaces an overlay's whole picture
// with the primitives it is given, in the well's own pixels.
//
//   pip <hand> <hwnd> | pip <hand> off        a tile for this window; the reply is `tile` below
//   label <hand> <state> <text>               the tile's strip and ring: working | blocked | done | error | idle
//   draw <hand> <primitive>;<primitive>;...   see Overlay.Draw for the primitives
//   listening | transcript <text> | finishing the card while the key is held
//   task <hand> <status> <text>               a row: running | queued | done | failed | stopped
//   progress <hand> <text>                    the narrator's line under that hand's row
//   ask <id> <hand> <seconds> <what> <target> the question (both base64); Ctrl+Alt+Y and Ctrl+Alt+N answer it
//   answered <id>                             the question was settled elsewhere
//   rows                                      put the words away and keep the rows
//   hide                                      put the card away
//
//   -> ready
//   -> tile <hand> <well width> <well height> <source width> <source height>
//   -> answer <id> yes|no
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Feed
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int W, H; }
    [StructLayout(LayoutKind.Sequential)] public struct BLENDFUNCTION { public byte Op, Flags, Alpha, Format; }
    [StructLayout(LayoutKind.Sequential)] public struct THUMBNAIL { public int Flags; public RECT Destination, Source; public byte Opacity; public int Visible, ClientOnly; }

    [DllImport("dwmapi.dll")] public static extern int DwmRegisterThumbnail(IntPtr destination, IntPtr source, out IntPtr thumbnail);
    [DllImport("dwmapi.dll")] public static extern int DwmUnregisterThumbnail(IntPtr thumbnail);
    [DllImport("dwmapi.dll")] public static extern int DwmUpdateThumbnailProperties(IntPtr thumbnail, ref THUMBNAIL properties);
    [DllImport("dwmapi.dll")] public static extern int DwmQueryThumbnailSourceSize(IntPtr thumbnail, out SIZE size);
    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    [DllImport("user32.dll")] public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr destination, ref POINT at, ref SIZE size, IntPtr source, ref POINT from, int key, ref BLENDFUNCTION blend, int flags);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hwnd, int id);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr handle);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr handle);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);

    // Never activated, never in the taskbar or Alt+Tab; the layered two also let every click through.
    public const int WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOOLWINDOW = 0x80, WS_EX_TOPMOST = 0x8, WS_EX_LAYERED = 0x80000, WS_EX_TRANSPARENT = 0x20;
    public const int WM_MOUSEACTIVATE = 0x21, MA_NOACTIVATE = 3, WM_HOTKEY = 0x312, SW_HIDE = 0, SW_SHOWNOACTIVATE = 4;

    public static readonly Color Slab = Color.FromArgb(22, 22, 30), Well = Color.FromArgb(11, 11, 16), Ink = Color.FromArgb(11, 18, 32);
    public static readonly Color Text = Color.FromArgb(232, 236, 245), Muted = Color.FromArgb(141, 149, 169);
    public static readonly Color Working = Color.FromArgb(122, 162, 247), Blocked = Color.FromArgb(224, 175, 104), Failed = Color.FromArgb(247, 118, 142), Done = Color.FromArgb(158, 206, 106), Idle = Color.FromArgb(65, 72, 104);
    static readonly Color[] HandColors = { Color.FromArgb(122, 162, 247), Color.FromArgb(187, 154, 247), Color.FromArgb(115, 218, 202), Color.FromArgb(255, 158, 100) };

    public static Color HandColor(int hand) { return HandColors[(Math.Max(1, hand) - 1) % HandColors.Length]; }
    public static Color StateColor(string state) { return state == "working" || state == "running" ? Working : state == "blocked" ? Blocked : state == "error" || state == "failed" ? Failed : state == "done" ? Done : Idle; }
    public static Color Alpha(Color c, double a) { return Color.FromArgb((int)Math.Round(255 * Math.Max(0, Math.Min(1, a))), c.R, c.G, c.B); }
    public static Color Hex(string s) { int v = int.Parse(s, NumberStyles.HexNumber, CultureInfo.InvariantCulture); return Color.FromArgb((v >> 16) & 255, (v >> 8) & 255, v & 255); }
    public static float Num(string s) { return float.Parse(s, CultureInfo.InvariantCulture); }
    public static string Words(string base64) { try { return base64 == "-" ? "" : Encoding.UTF8.GetString(Convert.FromBase64String(base64)); } catch (FormatException) { return ""; } }
    public static void Say(string line) { Console.Out.WriteLine(line); Console.Out.Flush(); }

    public static Font Face(float pixels, FontStyle style)
    {
        foreach (string name in new string[] { "Segoe UI Variable Text", "Segoe UI" })
        {
            try { return new Font(name, pixels, style, GraphicsUnit.Pixel); } catch (Exception) { /* a face may lack a style; the next one has it */ }
        }
        return new Font(FontFamily.GenericSansSerif, pixels, FontStyle.Regular, GraphicsUnit.Pixel);
    }

    public static GraphicsPath Rounded(RectangleF r, float radius)
    {
        float d = Math.Max(0.1f, Math.Min(radius * 2, Math.Min(r.Width, r.Height)));
        GraphicsPath path = new GraphicsPath();
        path.AddArc(r.X, r.Y, d, d, 180, 90); path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    /** Cut to a width, keeping the start (a caption), the end (text being typed) or both ends (an address). */
    public static string Fit(Graphics g, string text, Font font, float width, string keep)
    {
        if (text.Length == 0 || g.MeasureString(text, font).Width <= width) return text;
        const string dots = "…";
        int low = 0, high = text.Length;
        while (low < high)
        {
            int mid = (low + high + 1) / 2;
            if (g.MeasureString(Cut(text, mid, keep, dots), font).Width <= width) low = mid; else high = mid - 1;
        }
        return low == 0 ? "" : Cut(text, low, keep, dots);
    }
    static string Cut(string text, int n, string keep, string dots)
    {
        if (keep == "end") return dots + text.Substring(text.Length - n);
        if (keep == "middle") return text.Substring(0, (n + 1) / 2) + dots + text.Substring(text.Length - n / 2);
        return text.Substring(0, n) + dots;
    }

    /** A picture with its own alpha onto a layered window: the only way such a window is ever painted. */
    public static void Push(IntPtr hwnd, Bitmap bitmap, int x, int y, byte opacity)
    {
        IntPtr screen = GetDC(IntPtr.Zero), memory = CreateCompatibleDC(screen), handle = IntPtr.Zero, previous = IntPtr.Zero;
        try
        {
            handle = bitmap.GetHbitmap(Color.FromArgb(0));
            previous = SelectObject(memory, handle);
            POINT at = new POINT(); at.X = x; at.Y = y;
            SIZE size = new SIZE(); size.W = bitmap.Width; size.H = bitmap.Height;
            POINT from = new POINT();
            BLENDFUNCTION blend = new BLENDFUNCTION(); blend.Alpha = opacity; blend.Format = 1; // AC_SRC_ALPHA
            UpdateLayeredWindow(hwnd, screen, ref at, ref size, memory, ref from, 0, ref blend, 2 /* ULW_ALPHA */);
        }
        finally
        {
            if (previous != IntPtr.Zero) SelectObject(memory, previous);
            if (handle != IntPtr.Zero) DeleteObject(handle);
            DeleteDC(memory);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }

    // ---------------------------------------------------------------- the mode

    static readonly Dictionary<int, Tile> tiles = new Dictionary<int, Tile>();
    static Card card;

    public static int Run()
    {
        // Windows want a single-threaded apartment, and Main is not marked as one.
        Thread ui = new Thread(delegate () { Loop(); });
        ui.SetApartmentState(ApartmentState.STA);
        ui.Start();
        ui.Join();
        return 0;
    }

    static void Loop()
    {
        Application.EnableVisualStyles();
        // The error dialog is the one window here that could take the focus from the user.
        Application.ThreadException += delegate (object s, ThreadExceptionEventArgs a) { Console.Error.WriteLine("feed: " + a.Exception.Message); };
        // What is said is not ASCII. A reader over the raw handle: setting Console.InputEncoding throws with no console.
        TextReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), false, 8192);
        card = new Card();
        Thread reader = new Thread(delegate ()
        {
            string line;
            while ((line = input.ReadLine()) != null)
            {
                string command = line.Trim().TrimStart((char)0xFEFF);
                if (command.Length == 0) continue;
                try { card.BeginInvoke((MethodInvoker)delegate () { try { Apply(command); } catch (Exception e) { Console.Error.WriteLine("feed: " + e.Message); } }); }
                catch (Exception) { break; } // the windows are gone
            }
            try { card.BeginInvoke((MethodInvoker)delegate () { Application.Exit(); }); } catch (Exception) { }
        });
        reader.IsBackground = true;
        reader.Start();
        Say("ready");
        Application.Run();
    }

    static void Apply(string line)
    {
        string[] p = line.Split(new char[] { ' ' }, 3);
        string command = p[0];
        if (command == "pip" || command == "label" || command == "draw")
        {
            int hand = int.Parse(p[1], CultureInfo.InvariantCulture);
            Tile tile;
            tiles.TryGetValue(hand, out tile);
            if (command == "pip")
            {
                string source = p.Length > 2 ? p[2] : "off";
                if (source == "off") { if (tile != null) { tiles.Remove(hand); tile.Remove(); } return; }
                if (tile == null)
                {
                    // The lowest free place in the stack: a tile that left must not leave the next one on top of a neighbour.
                    HashSet<int> taken = new HashSet<int>();
                    foreach (Tile other in tiles.Values) taken.Add(other.Slot);
                    int slot = 0;
                    while (taken.Contains(slot)) slot++;
                    tile = new Tile(hand, slot); tiles[hand] = tile;
                }
                tile.Watch(new IntPtr(long.Parse(source, CultureInfo.InvariantCulture)));
            }
            else if (tile == null) return;
            else if (command == "label") { string[] rest = (p.Length > 2 ? p[2] : "idle").Split(new char[] { ' ' }, 2); tile.Label(rest[0], rest.Length > 1 ? rest[1] : ""); }
            else tile.Overlay.Draw(p.Length > 2 ? p[2] : "");
        }
        else card.Apply(line);
    }
}

/** One hand's window, live, in the corner. It is never activated, and a click on it does nothing yet. */
class Tile : Form
{
    public readonly Overlay Overlay;
    public readonly int Slot;
    readonly int hand;
    IntPtr source = IntPtr.Zero, thumbnail = IntPtr.Zero;
    Feed.SIZE seen;
    string state = "idle", label = "";
    Rectangle well;
    readonly Font strong = Feed.Face(11, FontStyle.Bold), plain = Feed.Face(11, FontStyle.Regular);
    readonly System.Windows.Forms.Timer watch = new System.Windows.Forms.Timer();
    const int Pad = 5, Strip = 22;

    public Tile(int hand, int slot)
    {
        this.hand = hand; Slot = slot;
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual; BackColor = Feed.Slab;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        int width = Math.Max(300, Math.Min(440, area.Width / 5)), wellWidth = width - Pad * 2, wellHeight = wellWidth * 10 / 16;
        well = new Rectangle(Pad, Pad, wellWidth, wellHeight);
        Size = new Size(width, Pad + wellHeight + Strip + 2);
        // Bottom right, stacked upwards: the card has the bottom middle, and a page keeps what matters at its top left.
        Location = new Point(area.Right - width - 16, area.Bottom - 16 - (slot + 1) * Height - slot * 10);
        IntPtr created = Handle;
        int round = 2; // DWMWCP_ROUND; Windows 10 refuses the attribute and keeps square corners
        Feed.DwmSetWindowAttribute(Handle, 33, ref round, sizeof(int));
        Feed.ShowWindow(Handle, Feed.SW_SHOWNOACTIVATE);
        Overlay = new Overlay(Handle, new Rectangle(Left + well.Left, Top + well.Top, well.Width, well.Height));
        // A window that is resized changes the letterbox, and the pointer has to move with the picture.
        watch.Interval = 500;
        watch.Tick += delegate (object s, EventArgs e) { Place(); };
        watch.Start();
    }

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get { CreateParams p = base.CreateParams; p.ExStyle |= Feed.WS_EX_NOACTIVATE | Feed.WS_EX_TOOLWINDOW | Feed.WS_EX_TOPMOST; return p; }
    }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Feed.WM_MOUSEACTIVATE) { m.Result = new IntPtr(Feed.MA_NOACTIVATE); return; }
        base.WndProc(ref m);
    }

    public void Watch(IntPtr hwnd)
    {
        if (hwnd == source && thumbnail != IntPtr.Zero) { Report(); return; }
        if (thumbnail != IntPtr.Zero) { Feed.DwmUnregisterThumbnail(thumbnail); thumbnail = IntPtr.Zero; }
        source = hwnd;
        seen = new Feed.SIZE();
        if (Feed.DwmRegisterThumbnail(Handle, hwnd, out thumbnail) != 0) thumbnail = IntPtr.Zero;
        Place();
        Report();
        Invalidate();
    }

    public void Label(string state, string label) { this.state = state; this.label = label; Invalidate(); }

    /** The thumbnail fitted inside the well, all of it showing, centred: the same fit feed.ts gives the pointer. */
    void Place()
    {
        if (thumbnail == IntPtr.Zero) return;
        Feed.SIZE size;
        if (Feed.DwmQueryThumbnailSourceSize(thumbnail, out size) != 0 || size.W <= 0 || size.H <= 0) return;
        bool changed = size.W != seen.W || size.H != seen.H;
        seen = size;
        double scale = Math.Min((double)well.Width / size.W, (double)well.Height / size.H);
        // Halves round away from zero, as fit.ts rounds them: the pointer is placed by the same arithmetic.
        int w = Math.Max(1, (int)Math.Round(size.W * scale, MidpointRounding.AwayFromZero)), h = Math.Max(1, (int)Math.Round(size.H * scale, MidpointRounding.AwayFromZero));
        Feed.THUMBNAIL t = new Feed.THUMBNAIL();
        t.Flags = 1 | 4 | 8; // destination, opacity, visible
        t.Destination.Left = well.Left + (well.Width - w) / 2; t.Destination.Top = well.Top + (well.Height - h) / 2;
        t.Destination.Right = t.Destination.Left + w; t.Destination.Bottom = t.Destination.Top + h;
        t.Opacity = 255; t.Visible = 1;
        Feed.DwmUpdateThumbnailProperties(thumbnail, ref t);
        if (changed) Report();
    }

    void Report() { Feed.Say("tile " + hand + " " + well.Width + " " + well.Height + " " + seen.W + " " + seen.H); }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        g.Clear(Feed.Slab);
        using (SolidBrush dark = new SolidBrush(Feed.Well)) g.FillRectangle(dark, well);
        if (thumbnail == IntPtr.Zero) using (SolidBrush muted = new SolidBrush(Feed.Muted)) g.DrawString("no window yet", plain, muted, well.Left + 8, well.Top + 8);
        using (Pen ring = new Pen(Feed.StateColor(state), 2)) g.DrawRectangle(ring, 1, 1, Width - 2, Height - 2);
        string name = "H" + hand;
        float nameWidth = g.MeasureString(name, strong).Width, y = well.Bottom + 3;
        using (SolidBrush mine = new SolidBrush(Feed.HandColor(hand))) g.DrawString(name, strong, mine, Pad, y);
        using (SolidBrush muted = new SolidBrush(Feed.Muted)) g.DrawString(Feed.Fit(g, label, plain, Width - Pad * 2 - nameWidth - 4, "start"), plain, muted, Pad + nameWidth + 2, y);
    }

    public void Remove()
    {
        watch.Stop();
        if (thumbnail != IntPtr.Zero) { Feed.DwmUnregisterThumbnail(thumbnail); thumbnail = IntPtr.Zero; }
        Overlay.Close();
        Close();
    }
}

/** Where a hand's pointer is drawn: a window of nothing but alpha, owned by its tile so it is always just above it. */
class Overlay : Form
{
    readonly IntPtr owner;
    readonly Rectangle place;
    readonly Font strong = Feed.Face(10, FontStyle.Bold), plain = Feed.Face(10, FontStyle.Regular);
    static readonly PointF[] Arrow = { new PointF(0, 0), new PointF(0, 15.2f), new PointF(4.1f, 11.5f), new PointF(7, 17.8f), new PointF(9.8f, 16.5f), new PointF(6.9f, 10.4f), new PointF(12.4f, 10.4f) };

    public Overlay(IntPtr owner, Rectangle place)
    {
        this.owner = owner; this.place = place;
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
        SetStyle(ControlStyles.Opaque | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint, true);
        IntPtr created = Handle;
        Draw("");
        Feed.ShowWindow(Handle, Feed.SW_SHOWNOACTIVATE);
    }

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams p = base.CreateParams;
            p.Parent = owner; // for a top-level window this is its owner: always above the tile, gone with it
            p.ExStyle |= Feed.WS_EX_LAYERED | Feed.WS_EX_TRANSPARENT | Feed.WS_EX_TOOLWINDOW | Feed.WS_EX_TOPMOST | Feed.WS_EX_NOACTIVATE;
            return p;
        }
    }
    protected override void OnPaintBackground(PaintEventArgs e) { } // the layered surface is the picture
    protected override void OnPaint(PaintEventArgs e) { }

    /**
     * The whole picture, replaced. Numbers are the well's pixels, alphas 0..1, colours rrggbb, words base64 (`-` for none):
     *   pointer x y alpha scale arrow|ibeam|grab colour
     *   disc x y radius alpha colour
     *   ring x y radius width alpha colour dashed(0|1)
     *   arc x y radius start sweep width alpha colour       degrees
     *   rect x y w h alpha fill colour                      fill is the alpha of the wash inside it
     *   line alpha width colour x,y x,y ...
     *   band x y w h alpha colour                           a wash ending in a line at y
     *   tag x y alpha colour accent note(0..1) caret(0|1) start|end label words     x,y is the pointer's tip
     *   chip x bottom room alpha colour start|middle label words                   x is its centre
     */
    public void Draw(string primitives)
    {
        using (Bitmap picture = new Bitmap(place.Width, place.Height, System.Drawing.Imaging.PixelFormat.Format32bppPArgb))
        {
            using (Graphics g = Graphics.FromImage(picture))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.AntiAlias; // ClearType has no alpha
                g.Clear(Color.Transparent);
                foreach (string primitive in primitives.Split(';'))
                {
                    string[] a = primitive.Trim().Split(' ');
                    try { One(g, a); } catch (Exception) { /* one bad primitive is not the frame's trouble */ }
                }
            }
            Feed.Push(Handle, picture, place.Left, place.Top, 255);
        }
    }

    /** Every coloured stroke goes over a wider dark one, so a pastel reads on a white page and on a black one. */
    void Both(Graphics g, GraphicsPath path, Color color, float width, double alpha, bool dashed)
    {
        using (Pen under = new Pen(Feed.Alpha(Feed.Ink, alpha * 0.5), width + 1.6f)) { under.LineJoin = LineJoin.Round; under.StartCap = under.EndCap = LineCap.Round; g.DrawPath(under, path); }
        using (Pen over = new Pen(Feed.Alpha(color, alpha), width))
        {
            over.LineJoin = LineJoin.Round; over.StartCap = over.EndCap = LineCap.Round;
            if (dashed) over.DashPattern = new float[] { 2, 1.5f };
            g.DrawPath(over, path);
        }
    }

    void One(Graphics g, string[] a)
    {
        string kind = a[0];
        if (kind == "pointer") Pointer(g, Feed.Num(a[1]), Feed.Num(a[2]), Feed.Num(a[3]), Feed.Num(a[4]), a[5], Feed.Hex(a[6]));
        else if (kind == "disc")
        {
            float r = Feed.Num(a[3]);
            using (SolidBrush fill = new SolidBrush(Feed.Alpha(Feed.Hex(a[5]), Feed.Num(a[4])))) g.FillEllipse(fill, Feed.Num(a[1]) - r, Feed.Num(a[2]) - r, r * 2, r * 2);
        }
        else if (kind == "ring" || kind == "arc")
        {
            float r = Feed.Num(a[3]);
            bool arc = kind == "arc";
            using (GraphicsPath path = new GraphicsPath())
            {
                if (arc) path.AddArc(Feed.Num(a[1]) - r, Feed.Num(a[2]) - r, r * 2, r * 2, Feed.Num(a[4]), Feed.Num(a[5]));
                else path.AddEllipse(Feed.Num(a[1]) - r, Feed.Num(a[2]) - r, r * 2, r * 2);
                int i = arc ? 6 : 4;
                Both(g, path, Feed.Hex(a[i + 2]), Feed.Num(a[i]), Feed.Num(a[i + 1]), !arc && a[i + 3] == "1");
            }
        }
        else if (kind == "rect")
        {
            Color color = Feed.Hex(a[7]);
            using (GraphicsPath path = Feed.Rounded(new RectangleF(Feed.Num(a[1]), Feed.Num(a[2]), Math.Max(1, Feed.Num(a[3])), Math.Max(1, Feed.Num(a[4]))), 4))
            {
                using (SolidBrush fill = new SolidBrush(Feed.Alpha(color, Feed.Num(a[6])))) g.FillPath(fill, path);
                Both(g, path, color, 1.8f, Feed.Num(a[5]), false);
            }
        }
        else if (kind == "line")
        {
            List<PointF> points = new List<PointF>();
            for (int i = 4; i < a.Length; i++) { string[] xy = a[i].Split(','); points.Add(new PointF(Feed.Num(xy[0]), Feed.Num(xy[1]))); }
            if (points.Count < 2) return;
            using (GraphicsPath path = new GraphicsPath()) { path.AddLines(points.ToArray()); Both(g, path, Feed.Hex(a[3]), Feed.Num(a[2]), Feed.Num(a[1]), false); }
        }
        else if (kind == "band")
        {
            float x = Feed.Num(a[1]), y = Feed.Num(a[2]), w = Feed.Num(a[3]), h = Math.Max(1, Feed.Num(a[4]));
            double alpha = Feed.Num(a[5]);
            Color color = Feed.Hex(a[6]);
            RectangleF wash = new RectangleF(x, y - h, w, h);
            using (LinearGradientBrush fill = new LinearGradientBrush(wash, Feed.Alpha(color, 0), Feed.Alpha(color, 0.28 * alpha), 90f)) g.FillRectangle(fill, wash);
            using (GraphicsPath path = new GraphicsPath()) { path.AddLine(x, y, x + w, y); Both(g, path, color, 1.5f, 0.9 * alpha, false); }
        }
        else if (kind == "tag") NameTag(g, a);
        else if (kind == "chip") Chip(g, a);
    }

    void Pointer(Graphics g, float x, float y, double alpha, float scale, string shape, Color color)
    {
        GraphicsState saved = g.Save();
        g.TranslateTransform(x, y); g.ScaleTransform(scale, scale);
        using (GraphicsPath path = new GraphicsPath())
        {
            if (shape == "ibeam") { path.AddLine(-3.5f, -8, 3.5f, -8); path.StartFigure(); path.AddLine(0, -8, 0, 8); path.StartFigure(); path.AddLine(-3.5f, 8, 3.5f, 8); }
            else if (shape == "grab") path.AddEllipse(-5.5f, -5.5f, 11, 11);
            else path.AddPolygon(Arrow);
            // The shadow, then the white edge, then the hand's colour: the body never changes colour, so a hand is always its own.
            g.TranslateTransform(0, 1);
            using (Pen shadow = new Pen(Feed.Alpha(Color.Black, 0.3 * alpha), shape == "ibeam" ? 5.4f : 3.8f)) { shadow.LineJoin = LineJoin.Round; shadow.StartCap = shadow.EndCap = LineCap.Round; g.DrawPath(shadow, path); }
            g.TranslateTransform(0, -1);
            using (Pen edge = new Pen(Feed.Alpha(Color.White, alpha), shape == "ibeam" ? 4.2f : shape == "grab" ? 1.8f : 2.6f))
            {
                edge.LineJoin = LineJoin.Round; edge.StartCap = edge.EndCap = LineCap.Round;
                if (shape != "grab") g.DrawPath(edge, path);
                if (shape == "ibeam") using (Pen beam = new Pen(Feed.Alpha(color, alpha), 2)) { beam.StartCap = beam.EndCap = LineCap.Round; g.DrawPath(beam, path); }
                else using (SolidBrush body = new SolidBrush(Feed.Alpha(color, alpha))) g.FillPath(body, path);
                if (shape == "grab") g.DrawPath(edge, path);
                else if (shape != "ibeam") using (Pen thin = new Pen(Feed.Alpha(Feed.Ink, 0.55 * alpha), 0.6f)) g.DrawPath(thin, path);
            }
        }
        g.Restore(saved);
    }

    /** Who, and for a moment what: below and to the right of the tip, or on the other side near an edge, so it is never cut off. */
    void NameTag(Graphics g, string[] a)
    {
        float tipX = Feed.Num(a[1]), tipY = Feed.Num(a[2]);
        double alpha = Feed.Num(a[3]), noteAlpha = Feed.Num(a[6]);
        Color color = Feed.Hex(a[4]), accent = Feed.Hex(a[5]);
        bool caret = a[7] == "1";
        string label = Feed.Words(a[9]), words = Feed.Words(a[10]);
        const float pad = 5, height = 16;
        float labelWidth = g.MeasureString(label, strong, 1000, StringFormat.GenericTypographic).Width;
        float room = Math.Max(0, Math.Min(190, place.Width * 0.62f) - labelWidth - pad * 3);
        string note = noteAlpha > 0 && words.Length > 0 ? Feed.Fit(g, words, plain, room, a[8]) : "";
        float noteWidth = note.Length > 0 || caret ? g.MeasureString(note, plain, 1000, StringFormat.GenericTypographic).Width + (caret ? 4 : 0) + pad : 0;
        float width = labelWidth + pad * 2 + noteWidth * (float)Math.Min(1, noteAlpha * 1.6);
        float x = tipX + 12, y = tipY + 16;
        if (x + width > place.Width) x = tipX - 6 - width;
        if (y + height > place.Height) y = tipY - 8 - height;
        x = Math.Max(0, Math.Min(x, Math.Max(0, place.Width - width))); y = Math.Max(0, Math.Min(y, Math.Max(0, place.Height - height)));
        using (GraphicsPath path = Feed.Rounded(new RectangleF(x, y, width, height), 5))
        {
            using (SolidBrush fill = new SolidBrush(Feed.Alpha(color, alpha))) g.FillPath(fill, path);
            using (Pen edge = new Pen(accent.ToArgb() == color.ToArgb() ? Feed.Alpha(Feed.Ink, 0.45 * alpha) : Feed.Alpha(accent, alpha), 1)) g.DrawPath(edge, path);
        }
        using (SolidBrush ink = new SolidBrush(Feed.Alpha(Feed.Ink, alpha))) g.DrawString(label, strong, ink, x + pad, y + 1.5f, StringFormat.GenericTypographic);
        if (width - labelWidth - pad * 2 <= 1) return;
        Region clip = g.Clip;
        g.SetClip(new RectangleF(x, y, width - 2, height));
        float at = x + labelWidth + pad * 2;
        using (SolidBrush ink = new SolidBrush(Feed.Alpha(Feed.Ink, alpha * Math.Min(1, noteAlpha))))
        {
            g.DrawString(note, plain, ink, at, y + 1.5f, StringFormat.GenericTypographic);
            if (caret && (Environment.TickCount / 420) % 2 == 0) g.FillRectangle(ink, at + g.MeasureString(note, plain, 1000, StringFormat.GenericTypographic).Width + 1.5f, y + 3.5f, 1.2f, height - 7);
        }
        g.Clip = clip;
    }

    /** Going somewhere is not pointing at something: no pointer moves, a chip along the bottom edge says where. */
    void Chip(Graphics g, string[] a)
    {
        float centre = Feed.Num(a[1]), bottom = Feed.Num(a[2]), room = Feed.Num(a[3]);
        double alpha = Feed.Num(a[4]);
        Color color = Feed.Hex(a[5]);
        string label = Feed.Words(a[7]);
        float labelWidth = g.MeasureString(label, strong, 1000, StringFormat.GenericTypographic).Width + 4;
        string words = Feed.Fit(g, Feed.Words(a[8]), plain, Math.Max(40, room - labelWidth - 16), a[6]);
        float width = labelWidth + g.MeasureString(words, plain, 1000, StringFormat.GenericTypographic).Width + 16, height = 18;
        RectangleF r = new RectangleF(centre - width / 2, bottom - height, width, height);
        using (GraphicsPath path = Feed.Rounded(r, height / 2))
        {
            using (SolidBrush fill = new SolidBrush(Feed.Alpha(Color.FromArgb(16, 18, 27), 0.92 * alpha))) g.FillPath(fill, path);
            using (Pen edge = new Pen(Feed.Alpha(color, alpha), 1)) g.DrawPath(edge, path);
        }
        using (SolidBrush mine = new SolidBrush(Feed.Alpha(color, alpha))) g.DrawString(label, strong, mine, r.X + 8, r.Y + 2.5f, StringFormat.GenericTypographic);
        using (SolidBrush text = new SolidBrush(Feed.Alpha(Feed.Text, alpha))) g.DrawString(words, plain, text, r.X + 8 + labelWidth, r.Y + 2.5f, StringFormat.GenericTypographic);
    }
}

/** The card along the bottom of the screen: the words as they are said, the hands at work, the question. Click-through. */
class Card : Form
{
    class Row { public int Hand; public string Status = "", Request = "", Progress = ""; }
    readonly List<Row> rows = new List<Row>();
    string phase = "hidden", transcript = "";
    // The question: at most one at a time, the way one person can be asked one thing.
    string askId = "", askWhat = "", askTarget = "";
    int askHand, askUntil;
    bool polling, downYes, downNo;
    readonly System.Windows.Forms.Timer tick = new System.Windows.Forms.Timer();
    readonly Font title = Feed.Face(13, FontStyle.Bold), words = Feed.Face(17, FontStyle.Regular), body = Feed.Face(13, FontStyle.Regular), small = Feed.Face(12, FontStyle.Regular);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    const int Yes = 1, No = 2;

    public Card()
    {
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
        SetStyle(ControlStyles.Opaque | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint, true);
        IntPtr created = Handle; // now, on this thread: every command is marshalled through it
        tick.Interval = 100;
        tick.Tick += delegate (object s, EventArgs e) { Tick(); };
    }

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get { CreateParams p = base.CreateParams; p.ExStyle |= Feed.WS_EX_LAYERED | Feed.WS_EX_TRANSPARENT | Feed.WS_EX_TOOLWINDOW | Feed.WS_EX_TOPMOST | Feed.WS_EX_NOACTIVATE; return p; }
    }
    protected override void OnPaintBackground(PaintEventArgs e) { }
    protected override void OnPaint(PaintEventArgs e) { }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Feed.WM_HOTKEY) { Answer(m.WParam.ToInt32() == Yes); return; }
        base.WndProc(ref m);
    }

    public void Apply(string line)
    {
        string[] head = line.Split(new char[] { ' ' }, 2);
        string command = head[0], rest = head.Length > 1 ? head[1] : "";
        if (command == "listening") { transcript = ""; phase = "listening"; }
        else if (command == "transcript") transcript = rest;
        else if (command == "finishing") { if (phase == "listening") phase = "finishing"; }
        else if (command == "task" || command == "progress")
        {
            string[] p = rest.Split(new char[] { ' ' }, command == "task" ? 3 : 2);
            int hand;
            if (p.Length < 2 || !int.TryParse(p[0], out hand)) return;
            Row row = null;
            foreach (Row r in rows) if (r.Hand == hand) row = r;
            if (row == null) { if (command == "progress") return; row = new Row(); row.Hand = hand; rows.Add(row); }
            if (command == "progress") row.Progress = p[1];
            // How it was going is not how it went: a finished row drops the narrator's last line, a failed one keeps where it got to.
            else { row.Status = p[1]; row.Request = p.Length > 2 ? p[2] : ""; if (row.Status == "running" || row.Status == "done") row.Progress = ""; }
            if (phase != "listening") phase = "rows";
        }
        else if (command == "ask")
        {
            string[] p = rest.Split(' ');
            if (p.Length < 5) return;
            Release();
            askId = p[0]; int.TryParse(p[1], out askHand);
            int seconds; int.TryParse(p[2], out seconds);
            askUntil = Environment.TickCount + Math.Max(1, seconds) * 1000;
            askWhat = Feed.Words(p[3]); askTarget = Feed.Words(p[4]);
            // Registered, so the chord is the feed's alone while the question stands and never reaches the app in front.
            // Another program may own it already: then the keys are watched instead, as the hold key is.
            bool yes = Feed.RegisterHotKey(Handle, Yes, 0x1 | 0x2 | 0x4000 /* ALT, CONTROL, no repeat */, 0x59), no = Feed.RegisterHotKey(Handle, No, 0x1 | 0x2 | 0x4000, 0x4E);
            polling = !(yes && no);
            downYes = downNo = true; // a chord still held from before is not an answer
            tick.Start();
        }
        else if (command == "answered") { if (rest.Trim() == askId) Release(); }
        else if (command == "rows") { phase = rows.Count > 0 ? "rows" : "hidden"; transcript = ""; }
        else if (command == "hide") { phase = "hidden"; rows.Clear(); transcript = ""; }
        else return;
        Render();
    }

    void Release()
    {
        if (askId.Length == 0) return;
        Feed.UnregisterHotKey(Handle, Yes); Feed.UnregisterHotKey(Handle, No);
        askId = ""; tick.Stop();
    }

    void Answer(bool yes)
    {
        if (askId.Length == 0) return;
        Feed.Say("answer " + askId + " " + (yes ? "yes" : "no"));
        Release();
        Render();
    }

    void Tick()
    {
        if (askId.Length == 0) { tick.Stop(); return; }
        if (polling)
        {
            bool chord = (GetAsyncKeyState(0x11) & 0x8000) != 0 && (GetAsyncKeyState(0x12) & 0x8000) != 0;
            bool yes = chord && (GetAsyncKeyState(0x59) & 0x8000) != 0, no = chord && (GetAsyncKeyState(0x4E) & 0x8000) != 0;
            if (yes && !downYes) { Answer(true); return; }
            if (no && !downNo) { Answer(false); return; }
            downYes = yes; downNo = no;
        }
        Render(); // the countdown; feed.ts owns the timeout itself and says `answered` when it runs out
    }

    void Render()
    {
        bool asking = askId.Length > 0;
        if (!asking && phase == "hidden") { Feed.ShowWindow(Handle, Feed.SW_HIDE); return; }
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        int width = Math.Max(420, Math.Min(760, area.Width * 46 / 100)), pad = 16, inner = width - pad * 2;
        using (Bitmap measure = new Bitmap(1, 1))
        using (Graphics m = Graphics.FromImage(measure))
        {
            // Measured first, because the card is as tall as what it says.
            StringFormat wrap = new StringFormat(StringFormat.GenericTypographic); wrap.Trimming = StringTrimming.EllipsisCharacter;
            bool speaking = phase == "listening" || phase == "finishing";
            string said = transcript.Length > 0 ? transcript : (phase == "listening" ? "Listening…" : "");
            int saidHeight = speaking ? Math.Min(3 * 24, (int)Math.Ceiling(m.MeasureString(said.Length > 0 ? said : " ", words, inner, wrap).Height)) : 0;
            int height = pad;
            if (speaking) height += 20 + saidHeight + 6 + (rows.Count > 0 ? 8 : 0);
            foreach (Row r in rows) height += 22 + (r.Progress.Length > 0 ? (int)Math.Ceiling(Math.Min(2 * 18, m.MeasureString(r.Progress, small, inner - 34, wrap).Height)) + 2 : 0) + 8;
            int askHeight = asking ? 24 + (int)Math.Ceiling(Math.Min(2 * 20, m.MeasureString(askWhat, body, inner, wrap).Height)) + (askTarget.Length > 0 ? 20 : 0) + 26 : 0;
            if (asking) height += askHeight + (height > pad ? 8 : 0);
            height += pad - 8;
            if (height <= pad * 2 - 8) { Feed.ShowWindow(Handle, Feed.SW_HIDE); return; }

            using (Bitmap picture = new Bitmap(width, height, System.Drawing.Imaging.PixelFormat.Format32bppPArgb))
            {
                using (Graphics g = Graphics.FromImage(picture))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.AntiAlias;
                    g.Clear(Color.Transparent);
                    using (GraphicsPath slab = Feed.Rounded(new RectangleF(0.5f, 0.5f, width - 1, height - 1), 14))
                    {
                        using (SolidBrush fill = new SolidBrush(Color.FromArgb(18, 20, 28))) g.FillPath(fill, slab); // opaque: at 94% a terminal's white text read through the question
                        using (Pen edge = new Pen(asking ? Feed.Blocked : Color.FromArgb(40, 255, 255, 255), asking ? 1.6f : 1)) g.DrawPath(edge, slab);
                    }
                    float y = pad;
                    if (speaking)
                    {
                        Color live = phase == "listening" ? Feed.Done : Feed.Working;
                        using (SolidBrush dot = new SolidBrush(live)) g.FillEllipse(dot, pad, y + 4, 9, 9);
                        using (SolidBrush muted = new SolidBrush(Feed.Muted)) g.DrawString(phase == "listening" ? "Listening" : "Got it", title, muted, pad + 16, y, StringFormat.GenericTypographic);
                        y += 20;
                        // The newest words matter most: a long sentence keeps its end in view.
                        string shown = said;
                        while (shown.Length > 0 && m.MeasureString(shown, words, inner, wrap).Height > 3 * 24 + 1) shown = "…" + shown.Substring(Math.Min(shown.Length, Math.Max(2, shown.IndexOf(' ', 1) + 1)));
                        using (SolidBrush text = new SolidBrush(Feed.Text)) g.DrawString(shown, words, text, new RectangleF(pad, y, inner, saidHeight + 2), wrap);
                        y += saidHeight + 6 + (rows.Count > 0 ? 8 : 0);
                    }
                    // The hands at work stay under the words: a follow-up said mid-task must not hide how the task is going.
                    foreach (Row r in rows)
                    {
                        Color mine = Feed.HandColor(r.Hand);
                        using (GraphicsPath badge = Feed.Rounded(new RectangleF(pad, y + 1, 26, 17), 5)) using (SolidBrush fill = new SolidBrush(mine)) g.FillPath(fill, badge);
                        using (SolidBrush ink = new SolidBrush(Feed.Ink)) g.DrawString("H" + r.Hand, title, ink, pad + 4, y + 1.5f, StringFormat.GenericTypographic);
                        float statusWidth = g.MeasureString(r.Status, title, 1000, StringFormat.GenericTypographic).Width;
                        using (SolidBrush state = new SolidBrush(Feed.StateColor(r.Status))) g.DrawString(r.Status, title, state, pad + 34, y + 1.5f, StringFormat.GenericTypographic);
                        using (SolidBrush text = new SolidBrush(Feed.Text)) g.DrawString(Feed.Fit(g, r.Request, body, inner - 44 - statusWidth, "start"), body, text, pad + 42 + statusWidth, y + 1.5f, StringFormat.GenericTypographic);
                        y += 22;
                        if (r.Progress.Length > 0)
                        {
                            float h = (float)Math.Ceiling(Math.Min(2 * 18, g.MeasureString(r.Progress, small, inner - 34, wrap).Height));
                            using (SolidBrush muted = new SolidBrush(Feed.Muted)) g.DrawString(r.Progress, small, muted, new RectangleF(pad + 34, y, inner - 34, h + 2), wrap);
                            y += h + 2;
                        }
                        y += 8;
                    }
                    if (asking)
                    {
                        if (y > pad) y += 8;
                        using (SolidBrush amber = new SolidBrush(Feed.Blocked)) g.DrawString("H" + askHand + " needs your OK", title, amber, pad, y, StringFormat.GenericTypographic);
                        y += 24;
                        float h = (float)Math.Ceiling(Math.Min(2 * 20, g.MeasureString(askWhat, body, inner, wrap).Height));
                        using (SolidBrush text = new SolidBrush(Feed.Text)) g.DrawString(askWhat, body, text, new RectangleF(pad, y, inner, h + 2), wrap);
                        y += h;
                        if (askTarget.Length > 0) { using (SolidBrush muted = new SolidBrush(Feed.Muted)) g.DrawString(Feed.Fit(g, askTarget, small, inner, "middle"), small, muted, pad, y + 2, StringFormat.GenericTypographic); y += 20; }
                        int left = Math.Max(0, (askUntil - Environment.TickCount + 999) / 1000);
                        using (SolidBrush muted = new SolidBrush(Feed.Muted)) g.DrawString("Ctrl+Alt+Y  allow   ·   Ctrl+Alt+N  decline   ·   declines by itself in " + left + " s", small, muted, pad, y + 6, StringFormat.GenericTypographic);
                    }
                }
                Feed.Push(Handle, picture, area.Left + (area.Width - width) / 2, area.Bottom - height - 28, 255);
                Feed.ShowWindow(Handle, Feed.SW_SHOWNOACTIVATE);
            }
        }
    }
}
