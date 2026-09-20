// The Windows renderer of the on-screen hand: run as "<helper.exe> hand" and fed one JSON cue per line on stdin,
// as hand.ts describes them. A layered tool window that never activates and lets clicks through, whose pixels are
// pushed with UpdateLayeredWindow from a bitmap drawn in GDI+ sixty times a second. Colour emoji do not render in
// GDI+ (it falls back to Segoe UI Emoji's line art), so the glyph is that outline, filled with the hand's colour,
// with a dark contour and a soft shadow. All coordinates are physical pixels: the process is per-monitor DPI aware.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Hand
{
    public static int Run(string[] args)
    {
        HandNative.SetProcessDpiAwarenessContext(new IntPtr(-4)); // before the first window: every coordinate here is a physical pixel
        HandNative.timeBeginPeriod(1);
        var window = new HandWindow();
        IntPtr handle = window.Handle; // created hidden: shown by the first cue that says where
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var reader = new Thread(delegate ()
        {
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                string cue = line;
                if (cue.Trim().Length > 0) window.BeginInvoke((Action)delegate { window.Play(cue); });
            }
            window.BeginInvoke((Action)window.Depart); // the agent is gone
        });
        reader.IsBackground = true;
        reader.Start();
        int pending = 0;
        var ticker = new Thread(delegate ()
        {
            var clock = Stopwatch.StartNew();
            double next = 0;
            while (!window.IsDisposed)
            {
                next += 1000.0 / 60;
                double wait = next - clock.Elapsed.TotalMilliseconds;
                if (wait > 0) Thread.Sleep((int)Math.Ceiling(wait)); else next = clock.Elapsed.TotalMilliseconds;
                if (Interlocked.CompareExchange(ref pending, 1, 0) != 0) continue; // a frame is still queued: skip, do not pile up
                try { window.BeginInvoke((Action)delegate { pending = 0; window.Frame(); }); } catch (InvalidOperationException) { return; }
            }
        });
        ticker.IsBackground = true;
        ticker.Start();
        Application.Run();
        return 0;
    }
}

/** One pose's motion: a value passing smoothly through `values` over `seconds`, `repeat` times, then back to rest. */
class HandMove
{
    public const int TX = 0, TY = 1, SCALE = 2, ROTATE = 3, OPACITY = 4;
    public int Kind; public double[] Values; public double Seconds; public double Repeat;
    public HandMove(int kind, double[] values, double seconds, double repeat) { Kind = kind; Values = values; Seconds = seconds; Repeat = repeat; }
    public double At(double t)
    {
        double rest = Kind == SCALE || Kind == OPACITY ? 1 : 0;
        if (t < 0 || t >= Seconds * Repeat) return rest;
        double phase = (t % Seconds) / Seconds * (Values.Length - 1);
        int i = (int)phase;
        if (i >= Values.Length - 1) return Values[Values.Length - 1];
        double f = (1 - Math.Cos((phase - i) * Math.PI)) / 2;
        return Values[i] + (Values[i + 1] - Values[i]) * f;
    }
}

class HandWindow : Form
{
    const int W = 420, H = 264, BOX = 96, GLYPH_PX = 72, TAG = 36, TAG_FONT = 15, TOUCH_X = 210, TOUCH_Y = 110; // the touch point sits at a fixed spot of the window; the window is moved
    const double PX_PER_PT = 2, FOREVER = 1e9, LINGER_MS = 1400, FADE_MS = 300, FRAME_MS = 40; // a glyph is set at two pixels a point, as on a 2x Mac display
    static readonly Color GOLD = Color.FromArgb(255, 199, 56);
    static readonly Dictionary<string, object[]> POSES = new Dictionary<string, object[]> {
        { "wave", new object[] { "\U0001F44B", 0.45, 0.75 } }, { "point", new object[] { "\U0001F446", 0.28, 0.11 } }, { "press", new object[] { "\U0001F446", 0.28, 0.11 } },
        { "write", new object[] { "\u270D\uFE0F", 0.02, 0.81 } }, { "draw", new object[] { "\u270D\uFE0F", 0.02, 0.81 } }, { "key", new object[] { "\U0001F447", 0.48, 0.82 } },
        { "scroll", new object[] { "\u270C\uFE0F", 0.45, 0.13 } }, { "look", new object[] { "\U0001F590\uFE0F", 0.4, 0.47 } }, { "go", new object[] { "\U0001F449", 0.74, 0.42 } },
        { "wait", new object[] { "\u270B", 0.37, 0.47 } }, { "think", new object[] { "\U0001F446", 0.28, 0.11 } }, { "done", new object[] { "\U0001F44D", 0.36, 0.44 } }, { "stop", new object[] { "\u270B", 0.37, 0.47 } },
    };

    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly Bitmap canvas = new Bitmap(W, H, PixelFormat.Format32bppPArgb);
    readonly Dictionary<string, GraphicsPath> glyphs = new Dictionary<string, GraphicsPath>();
    readonly FontFamily emoji = new FontFamily("Segoe UI Emoji");
    readonly Font bold = new Font("Segoe UI", TAG_FONT, FontStyle.Bold, GraphicsUnit.Pixel), plain = new Font("Segoe UI", TAG_FONT, FontStyle.Regular, GraphicsUnit.Pixel);
    readonly StreamWriter stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    readonly string dump = Environment.GetEnvironmentVariable("HANDS_HAND_DUMP"); // a PNG of each new pose, for checking the drawing: captures leave the hand out

    string name = "", status = "", pose = "";
    Color tint = GOLD;
    double ax = 0.28, ay = 0.11; // where in its box the glyph touches the hand's position
    List<HandMove> moves = new List<HandMove>();
    List<HandMove> ring = new List<HandMove>();
    double struck = -1e9; // when the pose began
    double[] spot = { 0, 0 }, from = { 0, 0 }; // where the hand is, and where the glide started
    double glideAt = -1e9, glideMs = 0;
    IntPtr target = IntPtr.Zero; // the window ridden, or none
    double[] origin = { 0, 0 };
    double framed = -1e9; // when the target's frame was last read
    bool riding = false, shown = false, hovered = false, dumpPending = false;
    double faded = -1e9, leaving = -1e9; // when the hand began to appear, and when the agent left
    string drawn = ""; // what the bitmap shows, so that a frame that changes nothing costs one SetWindowPos
    int atX = int.MinValue, atY = int.MinValue;
    RectangleF glyphBox, tagBox; // in window pixels, for the hit test

    public HandWindow()
    {
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual; Text = "hand";
        SetBounds(-W, -H, W, H);
        stdout.AutoFlush = true;
    }
    protected override CreateParams CreateParams
    {
        get { CreateParams p = base.CreateParams; p.ExStyle |= HandNative.WS_EX_LAYERED | HandNative.WS_EX_TRANSPARENT | HandNative.WS_EX_TOOLWINDOW | HandNative.WS_EX_NOACTIVATE; return p; }
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        HandNative.SetWindowDisplayAffinity(Handle, HandNative.WDA_EXCLUDEFROMCAPTURE); // out of every capture, always: a shy cue is answered at once
    }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == HandNative.WM_MOUSEACTIVATE) { m.Result = (IntPtr)HandNative.MA_NOACTIVATE; return; } // a click on the hand never takes the user out of their app
        if (m.Msg == HandNative.WM_LBUTTONDOWN) stdout.Write("click\n");
        base.WndProc(ref m);
    }

    // ------------------------------------------------------------------ cues

    public void Play(string line)
    {
        Dictionary<string, object> cue;
        try { cue = HandJson.Parse(line) as Dictionary<string, object>; } catch (Exception error) { Console.Error.WriteLine("hand: " + error.Message); return; }
        if (cue == null) return;
        object value;
        if (cue.TryGetValue("color", out value) && value is List<object>)
        {
            var rgb = (List<object>)value;
            tint = Color.FromArgb(Channel(rgb[0]), Channel(rgb[1]), Channel(rgb[2]));
        }
        if (cue.TryGetValue("subject", out value) && value is Dictionary<string, object>) Ride((Dictionary<string, object>)value);
        if (cue.ContainsKey("name") || cue.ContainsKey("label"))
        {
            if (cue.TryGetValue("name", out value) && value is string) name = (string)value;
            if (cue.TryGetValue("label", out value) && value is string) status = (string)value;
        }
        if (cue.TryGetValue("pose", out value) && value is string)
        {
            double count = cue.TryGetValue("count", out value) && value is double ? (double)value : 1;
            double[] swipe = cue.TryGetValue("swipe", out value) ? Pair(value) : new double[] { 0, -1 };
            Strike((string)cue["pose"], count, swipe);
        }
        if (cue.TryGetValue("at", out value) && value is List<object>)
        {
            double ms = cue.TryGetValue("ms", out value) && value is double ? (double)value : 0;
            Glide(Pair(cue["at"]), ms);
        }
        if (cue.TryGetValue("shy", out value) && value is bool && (bool)value) stdout.Write("\n"); // never in a capture in the first place
        Frame();
    }

    static int Channel(object v) { return Math.Max(0, Math.Min(255, (int)Math.Round((v is double ? (double)v : 0) * 255))); }
    static double[] Pair(object v)
    {
        var list = v as List<object>;
        if (list == null || list.Count < 2) return new double[] { 0, 0 };
        return new double[] { list[0] is double ? (double)list[0] : 0, list[1] is double ? (double)list[1] : 0 };
    }

    void Ride(Dictionary<string, object> subject)
    {
        object value;
        IntPtr window = subject.TryGetValue("window", out value) && value is double ? new IntPtr((long)(double)value) : IntPtr.Zero;
        if (subject.TryGetValue("origin", out value)) origin = Pair(value);
        riding = true;
        faded = clock.Elapsed.TotalMilliseconds; // the hand comes up over its new subject
        framed = -1e9;
        if (window == target && shown) return;
        target = window;
        if (!shown) { HandNative.ShowWindow(Handle, HandNative.SW_SHOWNOACTIVATE); shown = true; }
        if (target == IntPtr.Zero)
        {
            HandNative.SetWindowLongPtr(Handle, HandNative.GWLP_HWNDPARENT, IntPtr.Zero);
            HandNative.SetWindowPos(Handle, HandNative.HWND_TOPMOST, 0, 0, 0, 0, HandNative.SWP_NOMOVE | HandNative.SWP_NOSIZE | HandNative.SWP_NOACTIVATE);
            return;
        }
        // Owned by the window it rides: Windows then keeps the hand right above it, and hides it while the window is minimized.
        HandNative.SetWindowPos(Handle, HandNative.HWND_NOTOPMOST, 0, 0, 0, 0, HandNative.SWP_NOMOVE | HandNative.SWP_NOSIZE | HandNative.SWP_NOACTIVATE);
        HandNative.SetWindowLongPtr(Handle, HandNative.GWLP_HWNDPARENT, target);
        IntPtr above = HandNative.GetWindow(target, HandNative.GW_HWNDPREV); // the order is only maintained from the target's next raise: set it now
        bool topmostAbove = above != IntPtr.Zero && (HandNative.GetWindowLong(above, HandNative.GWL_EXSTYLE) & HandNative.WS_EX_TOPMOST) != 0;
        if (!topmostAbove) HandNative.SetWindowPos(Handle, above, 0, 0, 0, 0, HandNative.SWP_NOMOVE | HandNative.SWP_NOSIZE | HandNative.SWP_NOACTIVATE);
    }

    void Strike(string name, double count, double[] swipe)
    {
        object[] entry;
        if (!POSES.TryGetValue(name, out entry)) return;
        pose = name; ax = (double)entry[1]; ay = (double)entry[2];
        struck = clock.Elapsed.TotalMilliseconds;
        moves = new List<HandMove>(); ring = new List<HandMove>();
        double px = PX_PER_PT;
        switch (name)
        {
            case "wave": moves.Add(new HandMove(HandMove.ROTATE, new double[] { 0, 0.3, -0.15, 0.3, -0.15, 0 }, 1.1, 2)); break;
            case "press":
                moves.Add(new HandMove(HandMove.SCALE, new double[] { 1, 0.76, 1 }, 0.2, count));
                ring.Add(new HandMove(HandMove.SCALE, new double[] { 0.2, 1.6 }, 0.45, count));
                ring.Add(new HandMove(HandMove.OPACITY, new double[] { 0.9, 0 }, 0.45, count));
                break;
            case "write": case "draw":
                moves.Add(new HandMove(HandMove.TX, new double[] { 0, 6 * px, 1 * px, 8 * px, 0 }, 0.5, FOREVER));
                moves.Add(new HandMove(HandMove.TY, new double[] { 0, -2 * px, 1 * px, -1 * px, 0 }, 0.5, FOREVER));
                break;
            case "key": moves.Add(new HandMove(HandMove.TY, new double[] { 0, 5 * px, 0 }, 0.18, count)); break;
            case "look": moves.Add(new HandMove(HandMove.TX, new double[] { -9 * px, 9 * px, -9 * px }, 1.8, FOREVER)); break;
            case "go": moves.Add(new HandMove(HandMove.TX, new double[] { 0, 8 * px, 0 }, 0.5, 3)); break;
            case "wait": moves.Add(new HandMove(HandMove.SCALE, new double[] { 1, 1.07, 1 }, 1.3, FOREVER)); break;
            case "think": moves.Add(new HandMove(HandMove.TY, new double[] { 0, -4 * px, 0 }, 1.7, FOREVER)); break;
            case "done": moves.Add(new HandMove(HandMove.SCALE, new double[] { 0.4, 1.2, 1 }, 0.4, 1)); break;
            case "scroll":
                for (int axis = 0; axis < 2; axis++) if (swipe[axis] != 0) moves.Add(new HandMove(axis == 0 ? HandMove.TX : HandMove.TY, new double[] { -14 * px * swipe[axis], 14 * px * swipe[axis] }, 0.45, 3));
                moves.Add(new HandMove(HandMove.OPACITY, new double[] { 0, 1, 1, 0 }, 0.45, 3));
                break;
        }
        dumpPending = dump != null;
    }

    void Glide(double[] at, double ms)
    {
        from = Position();
        spot = at;
        glideMs = ms;
        glideAt = ms > 0 ? clock.Elapsed.TotalMilliseconds : -1e9;
    }

    /** Where the hand is this instant: at `spot`, or on its way there along a slightly lifted curve. */
    double[] Position()
    {
        double t = clock.Elapsed.TotalMilliseconds - glideAt;
        if (glideMs <= 0 || t >= glideMs) return spot;
        double u = (1 - Math.Cos(Math.Max(0, t) / glideMs * Math.PI)) / 2;
        double sideX = (spot[1] - from[1]) * 0.16, sideY = (from[0] - spot[0]) * 0.16, lift = sideY > 0 ? -1 : 1;
        double cx = (from[0] + spot[0]) / 2 + sideX * lift, cy = (from[1] + spot[1]) / 2 + sideY * lift;
        double a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
        return new double[] { a * from[0] + b * cx + c * spot[0], a * from[1] + b * cy + c * spot[1] };
    }

    public void Depart()
    {
        if (!shown) { Application.Exit(); return; }
        leaving = clock.Elapsed.TotalMilliseconds;
    }

    // ------------------------------------------------------------------ frames

    public void Frame()
    {
        if (!riding || IsDisposed) return;
        double now = clock.Elapsed.TotalMilliseconds;
        if (leaving > 0 && now - leaving >= LINGER_MS + FADE_MS) { Close(); Application.Exit(); return; }
        if (target != IntPtr.Zero && now - framed >= FRAME_MS)
        {
            framed = now;
            HandNative.RECT frame;
            if (!HandNative.IsWindow(target) || HandNative.DwmGetWindowAttribute(target, HandNative.DWMWA_EXTENDED_FRAME_BOUNDS, out frame, 16) != 0)
            {
                if (shown) HandNative.ShowWindow(Handle, HandNative.SW_HIDE); // closed: the hand goes with it
                shown = false;
                return;
            }
            origin[0] = frame.left; origin[1] = frame.top;
            bool visible = HandNative.IsWindowVisible(target) && !HandNative.IsIconic(target);
            if (visible != shown) { HandNative.ShowWindow(Handle, visible ? HandNative.SW_SHOWNOACTIVATE : HandNative.SW_HIDE); shown = visible; }
        }
        if (!shown) return;

        double[] at = Position();
        int x = (int)Math.Round(origin[0] + at[0]) - TOUCH_X, y = (int)Math.Round(origin[1] + at[1]) - TOUCH_Y;
        double t = (now - struck) / 1000;
        double tx = 0, ty = 0, scale = 1, rotate = 0, opacity = 1, ringScale = 0, ringOpacity = 0;
        foreach (var move in moves)
        {
            double v = move.At(t);
            if (move.Kind == HandMove.TX) tx += v; else if (move.Kind == HandMove.TY) ty += v; else if (move.Kind == HandMove.SCALE) scale *= v; else if (move.Kind == HandMove.ROTATE) rotate += v; else opacity *= v;
        }
        foreach (var move in ring) { double v = move.At(t); if (move.Kind == HandMove.SCALE) ringScale = v; else ringOpacity = v; }
        double alpha = Math.Min(1, (now - faded) / 350);
        if (leaving > 0) alpha *= Math.Max(0, 1 - (now - leaving - LINGER_MS) / FADE_MS);

        // The window lets every click through, except while the mouse is on the hand or its tag: then it takes them, and swells a little to say so.
        HandNative.POINT cursor;
        HandNative.GetCursorPos(out cursor);
        var mouse = new PointF(cursor.x - x, cursor.y - y);
        bool over = leaving < 0 && (glyphBox.Contains(mouse) || tagBox.Contains(mouse));
        if (over != hovered)
        {
            hovered = over;
            int ex = HandNative.GetWindowLong(Handle, HandNative.GWL_EXSTYLE);
            HandNative.SetWindowLong(Handle, HandNative.GWL_EXSTYLE, over ? ex & ~HandNative.WS_EX_TRANSPARENT : ex | HandNative.WS_EX_TRANSPARENT);
        }
        double hover = hovered ? 1.12 : 1;

        string key = string.Join("|", new string[] { pose, name, status, tint.ToArgb().ToString(), R(tx), R(ty), R(scale * 100), R(rotate * 100), R(opacity * 100), R(ringScale * 100), R(ringOpacity * 100), R(hover * 100), R(alpha * 255) });
        if (key != drawn)
        {
            drawn = key;
            Draw(tx, ty, scale, rotate, opacity, ringScale, ringOpacity, hover);
            Push(x, y, (byte)Math.Round(alpha * 255));
        }
        else if (x != atX || y != atY) HandNative.SetWindowPos(Handle, IntPtr.Zero, x, y, 0, 0, HandNative.SWP_NOSIZE | HandNative.SWP_NOZORDER | HandNative.SWP_NOACTIVATE);
        atX = x; atY = y;
    }

    static string R(double v) { return Math.Round(v).ToString(CultureInfo.InvariantCulture); }

    GraphicsPath Glyph(string symbol)
    {
        GraphicsPath path;
        if (glyphs.TryGetValue(symbol, out path)) return path;
        path = new GraphicsPath();
        var format = new StringFormat(StringFormat.GenericTypographic);
        format.Alignment = StringAlignment.Center; format.LineAlignment = StringAlignment.Center;
        path.AddString(symbol, emoji, 0, GLYPH_PX, new RectangleF(0, 0, BOX, BOX), format);
        glyphs[symbol] = path;
        return path;
    }

    void Draw(double tx, double ty, double scale, double rotate, double opacity, double ringScale, double ringOpacity, double hover)
    {
        using (var g = Graphics.FromImage(canvas))
        {
            g.Clear(Color.Transparent);
            g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit; g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            var whole = new Matrix(); // the hand as one: it swells about the touch point while hovered
            whole.Translate(TOUCH_X, TOUCH_Y); whole.Scale((float)hover, (float)hover);

            if (ringOpacity > 0)
            {
                g.Transform = whole;
                float radius = (float)(44 * ringScale);
                using (var pen = new Pen(Color.FromArgb(Alpha(ringOpacity), tint), 6f)) g.DrawEllipse(pen, -radius, -radius, 2 * radius, 2 * radius);
            }

            var glyph = whole.Clone();
            glyph.Translate((float)tx, (float)ty); glyph.Rotate((float)(rotate * 180 / Math.PI)); glyph.Scale((float)scale, (float)scale); glyph.Translate((float)(-ax * BOX), (float)(-ay * BOX));
            var path = Glyph(pose.Length > 0 ? (string)POSES[pose][0] : (string)POSES["think"][0]);
            var shadow = glyph.Clone(); shadow.Translate(0, 2, MatrixOrder.Append);
            g.Transform = shadow;
            using (var pen = new Pen(Color.FromArgb(Alpha(0.35 * opacity), 0, 0, 0), 6f)) { pen.LineJoin = LineJoin.Round; g.DrawPath(pen, path); }
            g.Transform = glyph;
            using (var brush = new SolidBrush(Color.FromArgb(Alpha(opacity), tint))) g.FillPath(brush, path);
            using (var pen = new Pen(Color.FromArgb(Alpha(0.9 * opacity), 25, 25, 35), 1.5f)) { pen.LineJoin = LineJoin.Round; g.DrawPath(pen, path); }
            var corners = new PointF[] { new PointF(0, 0), new PointF(BOX, 0), new PointF(BOX, BOX), new PointF(0, BOX) };
            glyph.TransformPoints(corners);
            glyphBox = Extent(corners);

            // The name in full voice and what it is doing beside it, more quietly; the tag is cut to fit the window.
            g.Transform = whole;
            float cx = (float)(BOX * (0.5 - ax)), top = (float)(BOX * (1 - ay) + 12);
            float room = (float)(2 * Math.Min(TOUCH_X + cx * hover, W - TOUCH_X - cx * hover) / hover - 8);
            var typographic = new StringFormat(StringFormat.GenericTypographic); typographic.FormatFlags |= StringFormatFlags.NoWrap; typographic.Trimming = StringTrimming.EllipsisCharacter;
            SizeF nameSize = g.MeasureString(name, bold, 10000, typographic);
            float nameWidth = Math.Min(nameSize.Width, room - 18);
            string said = status.Length > 0 ? "  " + status : "";
            SizeF statusSize = said.Length > 0 ? g.MeasureString(said, plain, 10000, typographic) : SizeF.Empty;
            float statusWidth = Math.Min(statusSize.Width, room - 18 - nameWidth);
            float width = nameWidth + statusWidth + 18, left = cx - width / 2;
            using (var pill = new GraphicsPath())
            {
                pill.AddArc(left, top, TAG, TAG, 90, 180); pill.AddArc(left + width - TAG, top, TAG, TAG, 270, 180); pill.CloseFigure();
                using (var ink = new SolidBrush(Color.FromArgb(230, 23, 23, 28))) g.FillPath(ink, pill);
                using (var hair = new Pen(Color.FromArgb(70, 255, 255, 255), 1f)) g.DrawPath(hair, pill); // a hairline, or the tag is lost on a dark window
            }
            g.DrawString(name, bold, Brushes.White, new RectangleF(left + 9, top + (TAG - nameSize.Height) / 2, nameWidth + 1, nameSize.Height), typographic);
            if (statusWidth > 0) using (var faint = new SolidBrush(Color.FromArgb(180, 255, 255, 255))) g.DrawString(said, plain, faint, new RectangleF(left + 9 + nameWidth, top + (TAG - statusSize.Height) / 2, statusWidth + 1, statusSize.Height), typographic);
            var tagCorners = new PointF[] { new PointF(left, top), new PointF(left + width, top + TAG) };
            whole.TransformPoints(tagCorners);
            tagBox = Extent(tagCorners);
        }
        if (dumpPending) { dumpPending = false; try { canvas.Save(dump, ImageFormat.Png); } catch (Exception) { } }
    }

    static int Alpha(double opacity) { return Math.Max(0, Math.Min(255, (int)Math.Round(opacity * 255))); }
    static RectangleF Extent(PointF[] points)
    {
        float l = points[0].X, t = points[0].Y, r = l, b = t;
        foreach (var p in points) { l = Math.Min(l, p.X); t = Math.Min(t, p.Y); r = Math.Max(r, p.X); b = Math.Max(b, p.Y); }
        return RectangleF.FromLTRB(l, t, r, b);
    }

    /** Position, size and pixels in one call: the window is what the bitmap shows, alpha and all. */
    void Push(int x, int y, byte alpha)
    {
        IntPtr screen = HandNative.GetDC(IntPtr.Zero), memory = HandNative.CreateCompatibleDC(screen), bitmap = IntPtr.Zero, previous = IntPtr.Zero;
        try
        {
            bitmap = canvas.GetHbitmap(Color.FromArgb(0)); // keeps the alpha channel: GetHbitmap() without a colour flattens it
            previous = HandNative.SelectObject(memory, bitmap);
            var at = new HandNative.POINT(); at.x = x; at.y = y;
            var size = new HandNative.SIZE(); size.cx = W; size.cy = H;
            var zero = new HandNative.POINT();
            var blend = new HandNative.BLENDFUNCTION(); blend.op = 0; blend.flags = 0; blend.alpha = alpha; blend.format = 1; // AC_SRC_OVER, AC_SRC_ALPHA
            HandNative.UpdateLayeredWindow(Handle, screen, ref at, ref size, memory, ref zero, 0, ref blend, 2); // ULW_ALPHA
        }
        finally
        {
            if (previous != IntPtr.Zero) HandNative.SelectObject(memory, previous);
            if (bitmap != IntPtr.Zero) HandNative.DeleteObject(bitmap);
            HandNative.DeleteDC(memory);
            HandNative.ReleaseDC(IntPtr.Zero, screen);
        }
    }
}

/** Just enough JSON for a cue: objects, arrays, strings, numbers, true, false, null. */
static class HandJson
{
    public static object Parse(string text) { int i = 0; return Value(text, ref i); }
    static void Skip(string s, ref int i) { while (i < s.Length && char.IsWhiteSpace(s[i])) i++; }
    static object Value(string s, ref int i)
    {
        Skip(s, ref i);
        if (i >= s.Length) throw new FormatException("unexpected end of JSON");
        char c = s[i];
        if (c == '{')
        {
            var map = new Dictionary<string, object>();
            i++;
            for (;;)
            {
                Skip(s, ref i);
                if (i < s.Length && s[i] == '}') { i++; return map; }
                string key = Text(s, ref i);
                Skip(s, ref i);
                if (i >= s.Length || s[i] != ':') throw new FormatException("':' expected");
                i++;
                map[key] = Value(s, ref i);
                Skip(s, ref i);
                if (i < s.Length && s[i] == ',') i++;
            }
        }
        if (c == '[')
        {
            var list = new List<object>();
            i++;
            for (;;)
            {
                Skip(s, ref i);
                if (i < s.Length && s[i] == ']') { i++; return list; }
                list.Add(Value(s, ref i));
                Skip(s, ref i);
                if (i < s.Length && s[i] == ',') i++;
            }
        }
        if (c == '"') return Text(s, ref i);
        if (string.CompareOrdinal(s, i, "true", 0, 4) == 0) { i += 4; return true; }
        if (string.CompareOrdinal(s, i, "false", 0, 5) == 0) { i += 5; return false; }
        if (string.CompareOrdinal(s, i, "null", 0, 4) == 0) { i += 4; return null; }
        int start = i;
        while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
        return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
    }
    static string Text(string s, ref int i)
    {
        if (i >= s.Length || s[i] != '"') throw new FormatException("string expected");
        var sb = new StringBuilder();
        for (i++; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '"') { i++; return sb.ToString(); }
            if (c != '\\') { sb.Append(c); continue; }
            c = s[++i];
            if (c == 'u') { sb.Append((char)int.Parse(s.Substring(i + 1, 4), NumberStyles.HexNumber)); i += 4; }
            else sb.Append(c == 'n' ? '\n' : c == 't' ? '\t' : c == 'r' ? '\r' : c == 'b' ? '\b' : c == 'f' ? '\f' : c);
        }
        throw new FormatException("unterminated string");
    }
}

static class HandNative
{
    public const int GWL_EXSTYLE = -20, GWLP_HWNDPARENT = -8;
    public const int WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_TOPMOST = 0x8, WS_EX_LAYERED = 0x80000, WS_EX_NOACTIVATE = 0x08000000;
    public const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOZORDER = 4, SWP_NOACTIVATE = 0x10, GW_HWNDPREV = 3;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1), HWND_NOTOPMOST = new IntPtr(-2);
    public const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4, WM_MOUSEACTIVATE = 0x21, WM_LBUTTONDOWN = 0x201, MA_NOACTIVATE = 3, DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    public const uint WDA_EXCLUDEFROMCAPTURE = 0x11;

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct BLENDFUNCTION { public byte op, flags, alpha, format; }

    [DllImport("user32.dll", SetLastError = true)] public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr dstDc, ref POINT dst, ref SIZE size, IntPtr srcDc, ref POINT src, int key, ref BLENDFUNCTION blend, int flags);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll", SetLastError = true)] public static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)] public static extern int SetWindowLong(IntPtr hwnd, int index, int value);
    [DllImport("user32.dll", SetLastError = true, EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
    [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
}
