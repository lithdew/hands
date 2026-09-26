// The Windows renderer of the on-screen hand: run as "<helper.exe> hand" and fed one JSON cue per line on stdin,
// as hand.ts describes them. A layered tool window that never activates and lets clicks through, kept right above
// the window it rides (and above everything while the hand borrows the user's mouse and keyboard), whose pixels are
// pushed with UpdateLayeredWindow from one bitmap drawn in GDI+. The glyph is the colour emoji, put together from the
// font's own colour layers (HandEmoji) and given the hand's colour the way the Mac does. All coordinates are physical
// pixels: the process is per-monitor DPI aware, and every size is scaled to the DPI of the display the hand is on.
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
    const int FAULTS_TOLD = 5, FAULTS_BORNE = 50; // of one burst of faults: how many are told, and how many make a hand that is broken
    static readonly TimeSpan BURST = TimeSpan.FromSeconds(5);
    static int faults; // in the burst under way
    static DateTime burst = DateTime.MinValue; // when it began

    public static int Run(string[] args)
    {
        // A fault in a drawing must never end a run, nor put a .NET "Unhandled exception" dialog on the user's desktop
        // from a process they never started. One on the window's thread is told on stderr, which reaches the agent's
        // log, and the hand carries on; a hand that faults frame after frame is broken, and goes quietly, and the run
        // carries on unseen. Anywhere else the process is ending anyway: it is told, and ends without the dialog.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException); // before the first window, or it cannot be set
        Application.ThreadException += delegate (object sender, ThreadExceptionEventArgs e)
        {
            DateTime now = DateTime.UtcNow;
            if (now - burst > BURST) { burst = now; faults = 0; }
            faults++;
            if (faults <= FAULTS_TOLD) Tell("hand: " + e.Exception);
            if (faults >= FAULTS_BORNE) { Tell("hand: faulted " + faults + " times in a few seconds, and has gone"); Environment.Exit(1); }
        };
        AppDomain.CurrentDomain.UnhandledException += delegate (object sender, UnhandledExceptionEventArgs e)
        {
            Tell("hand: " + e.ExceptionObject);
            Environment.Exit(1);
        };
        HandNative.SetProcessDpiAwarenessContext(new IntPtr(-4)); // before the first window: every coordinate here is a physical pixel
        HandNative.timeBeginPeriod(1);
        var window = new HandWindow();
        IntPtr handle = window.Handle; // created hidden: shown once a cue says where
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var reader = new Thread(delegate ()
        {
            try
            {
                string line;
                while ((line = stdin.ReadLine()) != null)
                {
                    string cue = line;
                    if (cue.Trim().Length > 0) window.BeginInvoke((Action)delegate { window.Play(cue); });
                }
            }
            catch (InvalidOperationException) { return; } // the window has gone first
            catch (IOException) { } // the pipe broke: the agent is as gone as if it had closed it
            try { window.BeginInvoke((Action)window.Depart); } // the agent is gone
            catch (InvalidOperationException) { }
        });
        reader.IsBackground = true;
        reader.Start();
        int pending = 0;
        var ticker = new Thread(delegate ()
        {
            var clock = Stopwatch.StartNew();
            double next = 0, posted = -1e9;
            bool composed = true; // whether Windows can say when the screen is next composed (build 22000 on)
            while (!window.IsDisposed)
            {
                // In step with the screen's refresh, so that a glide does not judder on a fast one; but a 240 Hz panel is
                // composed every 4 ms, so only a tick at least 12 ms after the last makes a frame: 60 to 80 a second. Where
                // Windows cannot say, about sixty a second.
                uint ticked = 1;
                if (composed) try { ticked = HandNative.DCompositionWaitForCompositorClock(0, null, 100); } catch (EntryPointNotFoundException) { composed = false; } catch (DllNotFoundException) { composed = false; }
                if (ticked != 0)
                {
                    next += 1000.0 / 60;
                    double wait = next - clock.Elapsed.TotalMilliseconds;
                    if (wait > 0) Thread.Sleep((int)Math.Ceiling(wait)); else next = clock.Elapsed.TotalMilliseconds;
                }
                else if (clock.Elapsed.TotalMilliseconds - posted < 12) continue;
                posted = clock.Elapsed.TotalMilliseconds;
                if (Interlocked.CompareExchange(ref pending, 1, 0) != 0) continue; // a frame is still queued: skip, do not pile up
                try { window.BeginInvoke((Action)delegate { pending = 0; window.Frame(); }); } catch (InvalidOperationException) { return; }
            }
        });
        ticker.IsBackground = true;
        ticker.Start();
        Application.Run();
        return 0;
    }

    /** A line on stderr, which may itself be gone. */
    public static void Tell(string line)
    {
        try { Console.Error.WriteLine(line); } catch (Exception) { }
    }
}

/** One pose's motion: a value passing smoothly through `values` over `seconds`, `repeat` times, then back to rest. */
class HandMove
{
    public const int TX = 0, TY = 1, SCALE = 2, ROTATE = 3, OPACITY = 4;
    public const double FOREVER = 1e9;
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
    /** Whether it is under way at `t`. An endless move never is: it is how a pose rests, and a resting pose is drawn at half the rate. */
    public bool Running(double t) { return Repeat < FOREVER && t >= 0 && t < Seconds * Repeat; }
}

/**
 * One thing the tag says, set once: the name and the rest of the words as two pictures, so that a new action crosses
 * over while the name stays still, and the pill they sit in.
 */
class HandTag
{
    public Bitmap Name, Rest;
    public string Voice = ""; // the name as it is set, colour and all: the same voice twice is left alone in a change
    public float Width, Height, Inset; // the pill's size, and how far down it the words start
    public Color Fill, Edge; public float EdgeWidth;
}

/** The hand at one instant, as a frame draws it. */
class HandLook
{
    public double Tx, Ty, Rotate, ScaleX = 1, ScaleY = 1, Opacity = 1; // the glyph, about its touch point
    public double Grow = 1, Drop; // the hand as one: swollen under the mouse, taking the seat, appearing, sinking as it goes
    public List<double[]> Rings = new List<double[]>(); // a press's ripples: radius, width, opacity
}

/**
 * How the hand looks at a moment: its pose and the pose's motion, the glide, the tag, and the seat, drawn into a bitmap
 * with the touch point at (TouchX, TouchY). Nothing here touches a window: HandWindow puts the bitmap on the screen.
 * Every motion is a function of the time it is drawn at, so a frame can be drawn at any rate, or skipped.
 */
class HandFigure
{
    // Every size is given at the scale it was set by eye (150%, 144 dpi), and multiplied by the display's own in Rescale.
    const double TUNED_DPI = 144, PX_PER_PT = 2; // a pose's motion is in points, two pixels each at the tuned scale, as on a 2x Mac display
    const int W = 420, H = 312, BOX = 96, GLYPH = 72, MARGIN = 12, TAG = 36, TAG_FONT = 15, TOUCH_X = 210, TOUCH_Y = 132;
    const double SWAP_MS = 160, FOLLOW_MS = 30, HOVER_MS = 40, APPEAR_MS = 200, LEAVE_MS = 220, PULSE_S = 1.2, LEAN = 0.1, GLIDE_DAMPING = 0.78;
    const double TAP_S = 0.18, DIP_S = 0.07, HOLD_S = 0.03, RIPPLE_S = 0.42, PRESS_S = 0.5; // a press: down, held, let go; a double click's second tap; its ripple; all of it
    const string HOLDING = "using your mouse & keyboard", WAITING = "waiting for you to pause";
    public static readonly Color GOLD = Color.FromArgb(255, 199, 56), INK = Color.FromArgb(23, 23, 28);
    // The glyph of each pose (hand.ts POSES), and where it touches what it points at, as a fraction of its box: a fingertip,
    // a pen's point, a palm. Read off renders of Segoe UI Emoji, whose ink spans about 0.14 to 0.86 of the box either way.
    static readonly Dictionary<string, object[]> POSES = new Dictionary<string, object[]> {
        { "wave", new object[] { "\U0001F44B", 0.58, 0.78 } }, { "point", new object[] { "\U0001F446", 0.38, 0.16 } }, { "press", new object[] { "\U0001F446", 0.38, 0.16 } },
        { "write", new object[] { "✍️", 0.21, 0.85 } }, { "draw", new object[] { "✍️", 0.21, 0.85 } }, { "key", new object[] { "\U0001F447", 0.56, 0.83 } },
        { "scroll", new object[] { "✌️", 0.55, 0.2 } }, { "look", new object[] { "\U0001F590️", 0.45, 0.6 } }, { "go", new object[] { "\U0001F449", 0.83, 0.38 } },
        { "wait", new object[] { "✋", 0.47, 0.6 } }, { "think", new object[] { "\U0001F446", 0.38, 0.16 } }, { "done", new object[] { "\U0001F44D", 0.5, 0.6 } }, { "stop", new object[] { "✋", 0.47, 0.6 } },
    };
    const double INK_BOTTOM = 0.86; // the tag hangs this far down the box, under the glyph's ink rather than its box

    readonly HandEmoji emoji = new HandEmoji();
    readonly Dictionary<string, HandTag> tags = new Dictionary<string, HandTag>();
    readonly Bitmap scratch = new Bitmap(1, 1); // to measure words on
    double k;
    public int Width, Height, TouchX, TouchY;
    int box, glyph, margin, tag;
    Font bold, plain, quiet;

    public string Name = "", Status = "", Pose = "", Seat = "", SeatWhy = "";
    public Color Tint = GOLD;
    public bool Tinted; // given a colour: without one the emoji keeps its own
    public bool Calm; // the system's animations are off: nothing loops, glides jump, a press only marks the spot
    double ax = 0.28, ay = 0.11; // where in its box the glyph touches the hand's position
    List<HandMove> moves = new List<HandMove>();
    int taps = 1;
    HandMove pop = new HandMove(HandMove.SCALE, new double[] { 1, 1.22, 0.96, 1 }, 0.45, 1); // the hand comes forward as it takes the seat
    double struck = -1e9, seated = -1e9; // when the pose began, and the seat's wait or hold
    double[] spot = { 0, 0 }, from = { 0, 0 }; // where the hand is, and where it set off from, in pixels from the subject's corner
    double glideAt = -1e9, glideMs = 0;
    bool following; // a place given without a time, as a drag streams them: the hand keeps close behind
    bool hovered; double hoverAt = -1e9, swellFrom = 1;
    double appeared = -1e9, left = -1e9; // when the hand came up, and when it began to go
    HandTag said, saying; // what the tag said before its last change, and says now
    HandTag was; float wasCx, wasTop; // the pill as it stood when the change began
    double swapped = -1e9;
    public RectangleF GlyphBox, TagBox; // in bitmap pixels, for the hit test

    public HandFigure() { Rescale(TUNED_DPI); }

    /** Physical pixels to the point (a Mac point, a Windows DIP) on the display the hand is sized for. */
    public double PixelsPerPoint { get { return k * TUNED_DPI / 96; } }
    double Px() { return PX_PER_PT * k; }
    int Scaled(double v) { return (int)Math.Round(v * k); }

    /** Size everything for a display at `dpi`. True when that changed the bitmap's size, which is then to be made again. */
    public bool Rescale(double dpi)
    {
        double next = Math.Max(0.5, dpi / TUNED_DPI);
        if (Math.Abs(next - k) < 0.01) return false;
        k = next;
        Width = Scaled(W); Height = Scaled(H); TouchX = Scaled(TOUCH_X); TouchY = Scaled(TOUCH_Y);
        box = Scaled(BOX); glyph = Scaled(GLYPH); margin = Scaled(MARGIN); tag = Scaled(TAG);
        foreach (var font in new Font[] { bold, plain, quiet }) if (font != null) font.Dispose();
        bold = new Font("Segoe UI", (float)(TAG_FONT * k), FontStyle.Bold, GraphicsUnit.Pixel);
        plain = new Font("Segoe UI", (float)(TAG_FONT * k), FontStyle.Regular, GraphicsUnit.Pixel);
        quiet = new Font("Segoe UI", (float)(13 * k), FontStyle.Regular, GraphicsUnit.Pixel);
        emoji.Forget();
        Forget(true);
        said = null; was = null; saying = Tag(); swapped = -1e9;
        return true;
    }

    // ------------------------------------------------------------------ what the cues change

    public void Strike(string name, double count, double[] swipe, double now)
    {
        object[] entry;
        if (!POSES.TryGetValue(name, out entry)) return;
        double x = (double)entry[1], y = (double)entry[2];
        if (x != ax || y != ay) Reset(now); // the tag hangs from the glyph's box: glide it to where the new one puts it
        Pose = name; ax = x; ay = y;
        struck = now;
        taps = Math.Max(1, (int)Math.Round(count));
        moves = new List<HandMove>();
        switch (name)
        {
            case "wave": moves.Add(new HandMove(HandMove.ROTATE, new double[] { 0, 0.3, -0.15, 0.3, -0.15, 0 }, 1.1, 2)); break;
            case "write": case "draw":
                moves.Add(new HandMove(HandMove.TX, new double[] { 0, 6, 1, 8, 0 }, 0.5, HandMove.FOREVER));
                moves.Add(new HandMove(HandMove.TY, new double[] { 0, -2, 1, -1, 0 }, 0.5, HandMove.FOREVER));
                break;
            case "key": moves.Add(new HandMove(HandMove.TY, new double[] { 0, 5, 0 }, 0.18, count)); break;
            case "look": moves.Add(new HandMove(HandMove.TX, new double[] { -9, 9, -9 }, 1.8, HandMove.FOREVER)); break;
            case "go": moves.Add(new HandMove(HandMove.TX, new double[] { 0, 8, 0 }, 0.5, 3)); break;
            case "wait": moves.Add(new HandMove(HandMove.SCALE, new double[] { 1, 1.07, 1 }, 1.3, HandMove.FOREVER)); break;
            case "think": moves.Add(new HandMove(HandMove.TY, new double[] { 0, -4, 0 }, 1.7, HandMove.FOREVER)); break;
            case "done": moves.Add(new HandMove(HandMove.SCALE, new double[] { 0.4, 1.2, 1 }, 0.4, 1)); break;
            case "scroll":
                for (int axis = 0; axis < 2; axis++) if (swipe[axis] != 0) moves.Add(new HandMove(axis == 0 ? HandMove.TX : HandMove.TY, new double[] { -14 * swipe[axis], 14 * swipe[axis] }, 0.45, 3));
                moves.Add(new HandMove(HandMove.OPACITY, new double[] { 0, 1, 1, 0 }, 0.45, 3));
                break;
        }
    }

    /** Go to `at` over `ms`. A place given without a time is followed closely, as a drag streams them, unless it is a `jump` to a new subject. */
    public void Glide(double[] at, double ms, double now, bool jump)
    {
        from = jump ? at : Position(now);
        spot = at;
        following = ms <= 0 && !jump && !Calm;
        glideMs = Calm ? 0 : ms;
        glideAt = now;
    }

    public void Label(string name, string status, double now)
    {
        if (name != null) Name = name;
        if (status != null) Status = status;
        Retag(now);
    }

    /** The hand is waiting to borrow the user's mouse and keyboard, holding them, or neither (state "free"). */
    public void Borrow(string state, string why, double now)
    {
        string next = state == "holding" || state == "waiting" ? state : "";
        if (next != Seat) seated = now;
        Seat = next;
        SeatWhy = next.Length > 0 ? why : "";
        Retag(now);
    }

    public void Hover(bool over, double now)
    {
        if (over == hovered) return;
        swellFrom = Swell(now);
        hovered = over;
        hoverAt = now;
    }

    public void Appear(double now) { appeared = now; left = -1e9; }
    /** Begin to go at `at`, which may be later than now. */
    public void Leave(double at) { left = at; }
    public bool Gone(double now) { return left > 0 && now >= left + LEAVE_MS; }

    // ------------------------------------------------------------------ motion

    /**
     * Where the hand is this instant: at `spot`, or on its way there along a slightly lifted curve. The way is a spring's:
     * away briskly, a little past the mark, and settled on it by the time the glide is over, which is when the action lands.
     */
    public double[] Position(double now)
    {
        double t = now - glideAt;
        if (following)
        {
            if (t >= 5 * FOLLOW_MS) return spot;
            double behind = Math.Exp(-Math.Max(0, t) / FOLLOW_MS);
            return new double[] { spot[0] + (from[0] - spot[0]) * behind, spot[1] + (from[1] - spot[1]) * behind };
        }
        if (glideMs <= 0 || t >= glideMs) return spot;
        double u = Settle(Math.Max(0, t) / glideMs);
        double sideX = (spot[1] - from[1]) * 0.16, sideY = (from[0] - spot[0]) * 0.16, lift = sideY > 0 ? -1 : 1;
        double cx = (from[0] + spot[0]) / 2 + sideX * lift, cy = (from[1] + spot[1]) / 2 + sideY * lift;
        double a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
        return new double[] { a * from[0] + b * cx + c * spot[0], a * from[1] + b * cy + c * spot[1] };
    }

    /** A damped spring's step response over u from 0 to 1, stopped at rest: it passes 1 by about two percent near two thirds of the way, and comes back. */
    public static double Settle(double u)
    {
        if (u >= 1) return 1;
        double zeta = GLIDE_DAMPING, decay = Math.Log(400); // at u = 1 what is left of the swing is a quarter of a percent
        double omega = decay / zeta, damped = omega * Math.Sqrt(1 - zeta * zeta), lean = zeta / Math.Sqrt(1 - zeta * zeta);
        double x = 1 - Math.Exp(-decay * u) * (Math.Cos(damped * u) + lean * Math.Sin(damped * u));
        double end = 1 - Math.Exp(-decay) * (Math.Cos(damped) + lean * Math.Sin(damped));
        return x + (1 - end) * u; // lands on 1 exactly
    }

    /** A spring's step response `t` seconds in, given how long it seems to take and how much it bounces (above 0), as kvin.me converts them. */
    public static double Spring(double t, double perceptual, double bounce)
    {
        double w = 2 * Math.PI / perceptual, z = 1 - bounce, wd = w * Math.Sqrt(1 - z * z);
        return 1 - Math.Exp(-z * w * t) * (Math.Cos(wd * t) + z * w / wd * Math.Sin(wd * t));
    }
    static double Ease3(double u) { return 1 - Math.Pow(1 - u, 3); }
    static double Ease5(double u) { return 1 - Math.Pow(1 - u, 5); }

    /** How far the hand leans into a glide, in radians: the fingertip leads and the rest of the hand trails it. */
    double Lean(double now)
    {
        double t = now - glideAt;
        if (following || glideMs <= 0 || t >= glideMs || t < 0) return 0;
        double way = Math.Max(-1, Math.Min(1, (spot[0] - from[0]) / (300 * k)));
        return LEAN * way * Math.Sin(Math.PI * t / glideMs) * (ay < 0.5 ? 1 : -1);
    }

    double Swell(double now)
    {
        double to = hovered ? 1.12 : 1;
        return Calm ? to : to + (swellFrom - to) * Math.Exp(-(now - hoverAt) / HOVER_MS);
    }

    /** How much of the hand shows: up quickly as it appears, down as it goes. */
    public double Opacity(double now)
    {
        double shown = Ease5(Math.Min(1, Math.Max(0, now - appeared) / APPEAR_MS));
        return left > 0 && now > left ? shown * (1 - Ease5(Math.Min(1, (now - left) / LEAVE_MS))) : shown;
    }

    HandLook Look(double now)
    {
        var look = new HandLook();
        double t = (now - struck) / 1000, px = Px();
        look.Rotate = Lean(now);
        if (!Calm)
            foreach (var move in moves)
            {
                double v = move.At(t);
                switch (move.Kind)
                {
                    case HandMove.TX: look.Tx += v * px; break;
                    case HandMove.TY: look.Ty += v * px; break;
                    case HandMove.SCALE: look.ScaleX *= v; look.ScaleY *= v; break;
                    case HandMove.ROTATE: look.Rotate += v; break;
                    default: look.Opacity *= v; break;
                }
            }
        if (Pose == "press") Press(look, t, px);
        double entrance = Calm ? 1 : 0.9 + 0.1 * Spring(Math.Max(0, now - appeared) / 1000, 0.3, 0.15);
        if (left > 0 && now > left) { double gone = Ease5(Math.Min(1, (now - left) / LEAVE_MS)); entrance = Calm ? 1 : 1 - 0.06 * gone; look.Drop = Calm ? 0 : 4 * k * gone; }
        look.Grow = Swell(now) * entrance * (Seat == "holding" && !Calm ? pop.At((now - seated) / 1000) : 1);
        return look;
    }

    /**
     * A press: down fast onto the fingertip, as a squash (shorter more than narrower), held a moment, and let go on a
     * spring that just overshoots. A ripple leaves the fingertip at the bottom of each tap, fast at first, its area
     * growing evenly. A double click is two taps, TAP_S apart.
     */
    void Press(HandLook look, double t, double px)
    {
        if (t < 0) return;
        if (Calm) { if (t < 0.15) look.Rings.Add(new double[] { 16 * px, 1.5 * px, 0.8 }); return; }
        int tap = (int)Math.Min(taps - 1, Math.Floor(t / TAP_S));
        double local = t - tap * TAP_S;
        double dip = local < DIP_S ? Ease5(local / DIP_S) : local < DIP_S + HOLD_S ? 1 : 1 - Spring(local - DIP_S - HOLD_S, 0.25, 0.3);
        look.ScaleX *= 1 - 0.1 * dip;
        look.ScaleY *= 1 - 0.2 * dip;
        for (int i = 0; i < taps; i++)
        {
            double p = (t - i * TAP_S - DIP_S) / RIPPLE_S;
            if (p < 0 || p >= 1) continue;
            double r0 = 5 * px, r1 = 26 * px;
            look.Rings.Add(new double[] { Math.Sqrt(r0 * r0 + (r1 * r1 - r0 * r0) * Ease5(p)), (2.5 - 1.75 * p) * px, 0.85 * (1 - p) });
        }
    }

    /** Whether something is under way that wants every frame; a resting pose, a hand that only breathes, does with half. */
    public bool Busy(double now)
    {
        double t = (now - struck) / 1000, since = now - glideAt;
        if (following ? since < 5 * FOLLOW_MS : glideMs > 0 && since < glideMs) return true;
        if (!Calm) foreach (var move in moves) if (move.Running(t)) return true;
        if (Pose == "press" && t >= 0 && t < (taps - 1) * TAP_S + PRESS_S) return true;
        if (now - hoverAt < 5 * HOVER_MS || now - appeared < 400 || (left > 0 && now > left)) return true;
        return now - swapped < SWAP_MS || Seat == "holding";
    }

    /** What a frame would show, as a string: the same string twice means there is nothing to draw. */
    public string Key(double now)
    {
        HandLook look = Look(now);
        var key = new StringBuilder(Pose);
        foreach (double v in new double[] { look.Tx, look.Ty, look.Rotate * 100, look.ScaleX * 100, look.ScaleY * 100, look.Opacity * 100, look.Grow * 100, look.Drop })
            key.Append('|').Append(Math.Round(v).ToString(CultureInfo.InvariantCulture));
        foreach (var ring in look.Rings) key.Append('|').Append(Math.Round(ring[0])).Append(',').Append(Math.Round(ring[2] * 50));
        key.Append('|').Append(Tint.ToArgb()).Append('|').Append(saying == null ? 0 : saying.GetHashCode());
        key.Append('|').Append(Math.Round(Math.Min(1, (now - swapped) / SWAP_MS) * 30));
        if (Seat.Length > 0 && !Calm) key.Append('|').Append(Seat).Append(Math.Round((now - seated) / (Seat == "holding" ? 16 : 40)));
        return key.ToString();
    }

    // ------------------------------------------------------------------ drawing

    public void Draw(Graphics g, double now)
    {
        HandLook look = Look(now);
        g.Clear(Color.Transparent);
        g.SmoothingMode = SmoothingMode.AntiAlias; g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        var whole = new Matrix(); // the hand as one, about its touch point
        whole.Translate(TouchX, (float)(TouchY + look.Drop)); whole.Scale((float)look.Grow, (float)look.Grow);

        DrawSeat(g, whole, now);
        g.Transform = whole;
        foreach (var ring in look.Rings) Ring(g, 0, 0, (float)ring[0], (float)ring[1], ring[2]);

        object[] entry = POSES[Pose.Length > 0 ? Pose : "think"];
        Bitmap picture = emoji.Picture((string)entry[0], glyph, box, margin, Tint, Tinted, Px());
        var place = whole.Clone();
        place.Translate((float)Math.Round(look.Tx), (float)Math.Round(look.Ty));
        place.Rotate((float)(look.Rotate * 180 / Math.PI));
        place.Scale((float)look.ScaleX, (float)look.ScaleY);
        place.Translate(-(float)Math.Round(margin + ax * box), -(float)Math.Round(margin + ay * box));
        g.Transform = place;
        Blit(g, picture, 0, 0, look.Opacity);
        var corners = new PointF[] { new PointF(margin, margin), new PointF(margin + box, margin), new PointF(margin + box, margin + box), new PointF(margin, margin + box) };
        place.TransformPoints(corners);
        GlyphBox = Extent(corners);

        DrawTag(g, whole, now);
        g.ResetTransform();
    }

    /**
     * While the seat is borrowed, rings go out round the hand, one after another, in its colour: impossible to miss, and
     * gone the moment the seat is given back. While it waits for the seat, a ring of dashes turns slowly round it.
     */
    void DrawSeat(Graphics g, Matrix whole, double now)
    {
        if (Seat.Length == 0) return;
        double px = Px(), t = (now - seated) / 1000;
        float cx = (float)(box * (0.5 - ax)), cy = (float)(box * (0.5 - ay)), round = (float)(box * 0.56);
        g.Transform = whole;
        if (Seat == "holding")
        {
            for (int i = 0; i < 2 && !Calm; i++)
            {
                if (t < i * PULSE_S / 2) continue;
                double u = (t / PULSE_S - i * 0.5) % 1;
                Ring(g, cx, cy, (float)(round + box * 0.3 * Ease3(u)), (float)((2.5 - 1.5 * u) * px), 0.7 * (1 - u));
            }
            Ring(g, cx, cy, round, (float)(2.5 * px), 1);
            return;
        }
        var turning = whole.Clone();
        turning.Translate(cx, cy);
        if (!Calm) turning.Rotate((float)(t * 90 % 360));
        g.Transform = turning;
        using (var pen = new Pen(Color.FromArgb(235, Tint), (float)(2 * px)))
        using (var rim = new Pen(Shade(0.45), (float)(2 * px) + 2))
        {
            pen.DashPattern = rim.DashPattern = new float[] { 2.4f, 1.6f };
            g.DrawEllipse(rim, -round, -round, 2 * round, 2 * round);
            g.DrawEllipse(pen, -round, -round, 2 * round, 2 * round);
        }
    }

    /** A ring in the hand's colour over a darker rim of it, so that a pale tint still shows on a white page. */
    void Ring(Graphics g, float cx, float cy, float radius, float width, double opacity)
    {
        if (opacity <= 0.01 || radius <= 0) return;
        using (var rim = new Pen(Shade(0.45 * opacity), width + 2)) g.DrawEllipse(rim, cx - radius, cy - radius, 2 * radius, 2 * radius);
        using (var pen = new Pen(Color.FromArgb(Alpha(opacity), Tint), width)) g.DrawEllipse(pen, cx - radius, cy - radius, 2 * radius, 2 * radius);
    }

    Color Shade(double opacity) { return Color.FromArgb(Alpha(opacity), Tint.R * 45 / 100, Tint.G * 45 / 100, Tint.B * 45 / 100); }

    /** The pill under the glyph. A change of words or of place glides it to its new size and spot, and the new words cross over the old. */
    void DrawTag(Graphics g, Matrix whole, double now)
    {
        TagBox = RectangleF.Empty;
        if (saying == null || saying.Width <= 0) return;
        double u = Math.Min(1, (now - swapped) / SWAP_MS), e = Ease3(u);
        HandTag before = was ?? saying;
        float width = Mix(before.Width, saying.Width, e), height = Mix(before.Height, saying.Height, e);
        float cx = Mix(was == null ? TagCx() : wasCx, TagCx(), e), top = Mix(was == null ? TagTop() : wasTop, TagTop(), e);
        // Centred under the glyph, but never cut by the edge of the window.
        float grow = whole.Elements[0], edge = Scaled(4);
        float left = Math.Max((edge - TouchX) / grow, Math.Min(cx - width / 2, (Width - edge - TouchX) / grow - width));
        g.Transform = whole;
        using (var pill = Pill(left, top, width, height))
        {
            using (var fill = new SolidBrush(Mix(before.Fill, saying.Fill, e))) g.FillPath(fill, pill);
            using (var rim = new Pen(Mix(before.Edge, saying.Edge, e), Mix(before.EdgeWidth, saying.EdgeWidth, e))) g.DrawPath(rim, pill);
            g.SetClip(pill);
            float x = left + Scaled(9);
            bool crossing = said != null && u < 1, sameName = crossing && said.Voice == saying.Voice;
            if (crossing)
            {
                if (!sameName) Blit(g, said.Name, x, top + said.Inset, 1 - e);
                Blit(g, said.Rest, x, top + said.Inset, 1 - e);
            }
            Blit(g, saying.Name, x, top + saying.Inset, crossing && !sameName ? e : 1);
            Blit(g, saying.Rest, x, top + saying.Inset, crossing ? e : 1);
            g.ResetClip();
        }
        var corners = new PointF[] { new PointF(left, top), new PointF(left + width, top + height) };
        whole.TransformPoints(corners);
        TagBox = Extent(corners);
    }

    /** A picture at whole pixels, as it was set, faded when asked. */
    static void Blit(Graphics g, Bitmap picture, float x, float y, double opacity)
    {
        if (picture == null || opacity <= 0.01) return;
        var whereTo = new Rectangle((int)Math.Round(x), (int)Math.Round(y), picture.Width, picture.Height);
        if (opacity >= 0.99) { g.DrawImage(picture, whereTo, 0, 0, picture.Width, picture.Height, GraphicsUnit.Pixel); return; }
        var matrix = new ColorMatrix(); matrix.Matrix33 = (float)opacity;
        using (var faded = new ImageAttributes())
        {
            faded.SetColorMatrix(matrix);
            g.DrawImage(picture, whereTo, 0, 0, picture.Width, picture.Height, GraphicsUnit.Pixel, faded);
        }
    }

    /** Say something else on the tag: the new words are set now, once, and cross over the old in DrawTag. */
    void Retag(double now)
    {
        HandTag next = Tag();
        if (next == saying) return;
        Reset(now);
        said = saying;
        saying = next;
    }

    /** Start a change of the pill from wherever it stands this instant, even halfway through the last one. */
    void Reset(double now)
    {
        if (saying == null) return;
        double u = Math.Min(1, (now - swapped) / SWAP_MS), e = Ease3(u);
        HandTag before = was ?? saying;
        var pill = new HandTag();
        pill.Width = Mix(before.Width, saying.Width, e); pill.Height = Mix(before.Height, saying.Height, e);
        pill.Fill = Mix(before.Fill, saying.Fill, e); pill.Edge = Mix(before.Edge, saying.Edge, e); pill.EdgeWidth = Mix(before.EdgeWidth, saying.EdgeWidth, e);
        wasCx = Mix(was == null ? TagCx() : wasCx, TagCx(), e); wasTop = Mix(was == null ? TagTop() : wasTop, TagTop(), e);
        was = pill;
        if (u >= 1) said = null;
        swapped = now;
    }

    /**
     * The tag for what the hand is doing: its name in full voice and the action beside it, more quietly, cut to fit.
     * While it waits for the seat or holds it, the action gives way to that, the pill takes a rim of the hand's colour
     * or the colour itself, and a second, quieter line says what the seat is for.
     */
    HandTag Tag()
    {
        int style = Seat == "holding" ? 2 : Seat == "waiting" ? 1 : 0;
        string doing = style == 2 ? HOLDING : style == 1 ? WAITING : Status, why = style > 0 ? SeatWhy : "";
        bool light = style == 2 && Light(Tint);
        Color voice = light ? INK : Color.White;
        string key = style + "\n" + Name + "\n" + doing + "\n" + why + "\n" + (style == 2 ? Tint.ToArgb() : 0);
        HandTag made;
        if (tags.TryGetValue(key, out made)) return made;
        if (tags.Count > 48) Forget(false);
        made = new HandTag();
        made.Fill = style == 2 ? Tint : Color.FromArgb(style == 1 ? 240 : 230, INK);
        made.Edge = style == 2 ? Shade(0.5) : style == 1 ? Tint : Color.FromArgb(70, 255, 255, 255); // a hairline, or the tag is lost on a dark window
        made.EdgeWidth = style == 1 ? Scaled(2) : Math.Max(1, Scaled(1));
        tags[key] = made;
        if (Name.Length == 0 && doing.Length == 0) return made; // nothing to say: no pill

        var typographic = new StringFormat(StringFormat.GenericTypographic);
        typographic.FormatFlags |= StringFormatFlags.NoWrap | StringFormatFlags.MeasureTrailingSpaces; typographic.Trimming = StringTrimming.EllipsisCharacter;
        float pad = Scaled(9), room = (Width - Scaled(8)) / 1.12f - 2 * pad, gap = Scaled(1);
        string beside = doing.Length > 0 ? "  " + doing : "";
        SizeF nameSize, besideSize, whySize;
        using (var measure = Graphics.FromImage(scratch))
        {
            nameSize = measure.MeasureString(Name, bold, 100000, typographic);
            besideSize = beside.Length > 0 ? measure.MeasureString(beside, plain, 100000, typographic) : SizeF.Empty;
            whySize = why.Length > 0 ? measure.MeasureString(why, quiet, 100000, typographic) : SizeF.Empty;
        }
        float nameWidth = Math.Min(nameSize.Width, room), besideWidth = Math.Min(besideSize.Width, room - nameWidth), whyWidth = Math.Min(whySize.Width, room);
        float line = Math.Max(nameSize.Height, besideSize.Height);
        int width = (int)Math.Ceiling(Math.Max(nameWidth + besideWidth, whyWidth)) + 2;
        int height = (int)Math.Ceiling(line + (why.Length > 0 ? gap + whySize.Height : 0));
        made.Voice = voice.ToArgb() + "\n" + Name;
        made.Name = new Bitmap((int)Math.Ceiling(nameWidth) + 2, Math.Max(1, (int)Math.Ceiling(line)), PixelFormat.Format32bppPArgb);
        made.Rest = new Bitmap(Math.Max(1, width), Math.Max(1, height), PixelFormat.Format32bppPArgb);
        // A box a few pixels taller than the line: given exactly its measured height, a line GDI+ has to cut is not drawn at all.
        using (var g = Graphics.FromImage(made.Name))
        using (var brush = new SolidBrush(voice))
        {
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit; // on a transparent bitmap: ClearType has no background to blend with
            g.DrawString(Name, bold, brush, new RectangleF(0, (line - nameSize.Height) / 2, nameWidth + 1, nameSize.Height + 4), typographic);
        }
        using (var g = Graphics.FromImage(made.Rest))
        using (var aside = new SolidBrush(Color.FromArgb(style == 0 ? 180 : 235, voice)))
        using (var small = new SolidBrush(Color.FromArgb(light ? 200 : 170, voice)))
        {
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            if (besideWidth > 0) g.DrawString(beside, plain, aside, new RectangleF(nameWidth, (line - besideSize.Height) / 2, besideWidth + 1, besideSize.Height + 4), typographic);
            if (whyWidth > 0) g.DrawString(why, quiet, small, new RectangleF(0, line + gap, whyWidth + 1, whySize.Height + 4), typographic);
        }
        made.Inset = (tag - line) / 2;
        made.Width = width + 2 * pad;
        made.Height = why.Length > 0 ? height + 2 * made.Inset : tag;
        return made;
    }

    /** Drop the tags that have been set: all of them, or all but those on show. */
    void Forget(bool all)
    {
        foreach (var entry in new List<KeyValuePair<string, HandTag>>(tags))
        {
            if (!all && (entry.Value == saying || entry.Value == said)) continue;
            if (entry.Value.Name != null) entry.Value.Name.Dispose();
            if (entry.Value.Rest != null) entry.Value.Rest.Dispose();
            tags.Remove(entry.Key);
        }
    }

    public bool Hits(float x, float y) { return GlyphBox.Contains(x, y) || TagBox.Contains(x, y); }

    /** Where the tag hangs, from the touch point: centred under the glyph's box, a little below its ink. */
    float TagCx() { return (float)(box * (0.5 - ax)); }
    float TagTop() { return (float)(box * (INK_BOTTOM - ay)) + Scaled(10); }

    GraphicsPath Pill(float left, float top, float width, float height)
    {
        float round = Math.Min(height, tag);
        var pill = new GraphicsPath();
        pill.AddArc(left, top, round, round, 180, 90);
        pill.AddArc(left + width - round, top, round, round, 270, 90);
        pill.AddArc(left + width - round, top + height - round, round, round, 0, 90);
        pill.AddArc(left, top + height - round, round, round, 90, 90);
        pill.CloseFigure();
        return pill;
    }

    static bool Light(Color c) { return 0.299 * c.R + 0.587 * c.G + 0.114 * c.B > 160; }
    static float Mix(float a, float b, double u) { return (float)(a + (b - a) * u); }
    static Color Mix(Color a, Color b, double u) { return Color.FromArgb((int)Mix(a.A, b.A, u), (int)Mix(a.R, b.R, u), (int)Mix(a.G, b.G, u), (int)Mix(a.B, b.B, u)); }
    static int Alpha(double opacity) { return Math.Max(0, Math.Min(255, (int)Math.Round(opacity * 255))); }
    static RectangleF Extent(PointF[] points)
    {
        float l = points[0].X, t = points[0].Y, r = l, b = t;
        foreach (var p in points) { l = Math.Min(l, p.X); t = Math.Min(t, p.Y); r = Math.Max(r, p.X); b = Math.Max(b, p.Y); }
        return RectangleF.FromLTRB(l, t, r, b);
    }
}

/**
 * Segoe UI Emoji in colour, for GDI+. GDI+ and WPF both set only the font's monochrome line art, so a colour emoji is put
 * together here from the font's own tables, read through GDI: COLR lists the glyphs each emoji is layered from, CPAL
 * their colours, and GetGlyphOutline gives each layer's outline. A font without those tables gets its line art, filled.
 */
class HandEmoji
{
    const int EM = 1024; // outlines are read at this size and scaled down, so that GDI's rounding to whole pixels is lost
    const double SKIN_LIGHT = 0.78; // how bright the emoji's own yellow is: the brightness that becomes the tint exactly
    readonly IntPtr dc;
    readonly byte[] cmap, colr, cpal;
    readonly Dictionary<string, Bitmap> pictures = new Dictionary<string, Bitmap>();

    public HandEmoji()
    {
        dc = HandNative.CreateCompatibleDC(IntPtr.Zero);
        HandNative.SelectObject(dc, HandNative.CreateFontW(-EM, 0, 0, 0, 400, 0, 0, 0, 1, 7, 0, 4, 0, "Segoe UI Emoji")); // DEFAULT_CHARSET, OUT_TT_ONLY_PRECIS, ANTIALIASED_QUALITY
        cmap = Table("cmap"); colr = Table("COLR"); cpal = Table("CPAL");
    }

    public void Forget()
    {
        foreach (var picture in pictures.Values) picture.Dispose();
        pictures.Clear();
    }

    /**
     * An emoji `glyph` pixels to the em, centred on its ink in a `box` with a `margin` round it for its shadow. In the
     * hand's colour when it has one: every pixel is given the tint at the brightness it had, as on the Mac (hand.ts
     * picture()), so the shading survives, a pen stays dark, and the skin, where the emoji is brightest, is the tint.
     */
    public Bitmap Picture(string symbol, int glyph, int box, int margin, Color tint, bool tinted, double px)
    {
        string key = symbol + "|" + glyph + "|" + box + "|" + margin + "|" + (tinted ? tint.ToArgb() : 0);
        Bitmap made;
        if (pictures.TryGetValue(key, out made)) return made;
        int side = box + 2 * margin;
        made = new Bitmap(side, side, PixelFormat.Format32bppPArgb);
        List<KeyValuePair<GraphicsPath, Color>> layers = Layers(char.ConvertToUtf32(symbol, 0));
        bool coloured = layers.Count > 0;
        if (!coloured) layers = LineArt(symbol, tinted ? tint : HandFigure.GOLD);
        var ink = RectangleF.Empty;
        foreach (var layer in layers) if (layer.Key.PointCount > 0) ink = ink.IsEmpty ? layer.Key.GetBounds() : RectangleF.Union(ink, layer.Key.GetBounds());
        using (var g = Graphics.FromImage(made))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias; g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            float scale = (float)glyph / EM;
            var place = new Matrix();
            place.Translate(margin + box / 2f, margin + box / 2f); place.Scale(scale, scale); place.Translate(-(ink.Left + ink.Width / 2), -(ink.Top + ink.Height / 2));
            g.Transform = place;
            foreach (var layer in layers) using (var brush = new SolidBrush(layer.Value)) g.FillPath(brush, layer.Key);
        }
        foreach (var layer in layers) layer.Key.Dispose();
        Finish(made, coloured && tinted, tint, px);
        pictures[key] = made;
        return made;
    }

    /** Tint the picture, then lay a soft shadow under it, as the Mac's glyph layer has. */
    static void Finish(Bitmap picture, bool tinting, Color tint, double px)
    {
        int w = picture.Width, h = picture.Height;
        var area = new Rectangle(0, 0, w, h);
        BitmapData data = picture.LockBits(area, ImageLockMode.ReadWrite, PixelFormat.Format32bppPArgb);
        var pixels = new byte[w * h * 4];
        Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
        var shade = new int[w * h];
        for (int i = 0, p = 0; p < pixels.Length; i++, p += 4)
        {
            if (tinting)
            {
                double light = (0.299 * pixels[p + 2] + 0.587 * pixels[p + 1] + 0.114 * pixels[p]) / SKIN_LIGHT / 255;
                pixels[p] = (byte)Math.Min(pixels[p + 3], tint.B * light);
                pixels[p + 1] = (byte)Math.Min(pixels[p + 3], tint.G * light);
                pixels[p + 2] = (byte)Math.Min(pixels[p + 3], tint.R * light);
            }
            shade[i] = pixels[p + 3];
        }
        int radius = Math.Max(1, (int)Math.Round(1.5 * px)), drop = Math.Max(1, (int)Math.Round(1.5 * px));
        Blur(shade, w, h, radius); Blur(shade, w, h, radius);
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                int p = 4 * (y * w + x), under = y >= drop ? shade[(y - drop) * w + x] : 0;
                int a = pixels[p + 3], shadow = under * 115 / 255; // black, at 45%
                pixels[p + 3] = (byte)(a + shadow * (255 - a) / 255); // the glyph over its shadow: premultiplied, so the colour stays as it is
            }
        Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
        picture.UnlockBits(data);
    }

    /** A box blur, across and then down; twice over it is close to a Gaussian. */
    static void Blur(int[] values, int w, int h, int radius)
    {
        var line = new int[Math.Max(w, h)];
        int span = 2 * radius + 1;
        for (int pass = 0; pass < 2; pass++)
        {
            int count = pass == 0 ? h : w, length = pass == 0 ? w : h, step = pass == 0 ? 1 : w, stride = pass == 0 ? w : 1;
            for (int n = 0; n < count; n++)
            {
                int start = n * stride, sum = 0;
                for (int i = 0; i < length; i++) line[i] = values[start + i * step];
                for (int i = -radius; i <= radius; i++) sum += i >= 0 && i < length ? line[i] : 0;
                for (int i = 0; i < length; i++)
                {
                    values[start + i * step] = sum / span;
                    int leaving = i - radius, entering = i + radius + 1;
                    sum += (entering < length ? line[entering] : 0) - (leaving >= 0 ? line[leaving] : 0);
                }
            }
        }
    }

    /**
     * The coloured layers of an emoji, bottom first, in pixels of the EM-sized font; none when the font has no colour for
     * it. The tables are read as the font gives them, and whatever font answers to the name: an offset that lies outside
     * its table means the colour cannot be trusted, and the line art is drawn instead.
     */
    List<KeyValuePair<GraphicsPath, Color>> Layers(int codepoint)
    {
        var layers = new List<KeyValuePair<GraphicsPath, Color>>();
        int glyph = GlyphOf(codepoint);
        if (glyph < 0 || !Has(colr, 0, 14) || !Has(cpal, 0, 14)) return layers;
        int bases = U16(colr, 2), baseAt = U32(colr, 4), layerAt = U32(colr, 8);
        int palette = U32(cpal, 8) + 4 * U16(cpal, 12); // the first palette's colours, four bytes each: blue, green, red, alpha
        for (int i = 0; i < bases; i++)
        {
            int record = baseAt + 6 * i;
            if (!Has(colr, record, 6)) break;
            if (U16(colr, record) != glyph) continue;
            for (int l = U16(colr, record + 2), end = l + U16(colr, record + 4); l < end; l++)
            {
                int layer = layerAt + 4 * l;
                int entry = Has(colr, layer, 4) ? U16(colr, layer + 2) : -1, at = palette + 4 * entry;
                if (entry < 0 || (entry != 0xFFFF && !Has(cpal, at, 4)))
                {
                    foreach (var made in layers) made.Key.Dispose();
                    layers.Clear();
                    return layers;
                }
                Color color = entry == 0xFFFF ? HandFigure.INK : Color.FromArgb(cpal[at + 3], cpal[at + 2], cpal[at + 1], cpal[at]); // 0xFFFF: the text's own colour
                layers.Add(new KeyValuePair<GraphicsPath, Color>(Outline(U16(colr, layer)), color));
            }
            break;
        }
        return layers;
    }

    /**
     * The font's monochrome line art, as a hand rather than a ring: each outer contour filled in `fill`, and the lines,
     * which are the contours inside them, dark on top.
     */
    static List<KeyValuePair<GraphicsPath, Color>> LineArt(string symbol, Color fill)
    {
        var art = new GraphicsPath();
        FontFamily family;
        try { family = new FontFamily("Segoe UI Emoji"); } catch (ArgumentException) { family = FontFamily.GenericSansSerif; }
        art.AddString(symbol, family, 0, EM, new PointF(0, 0), StringFormat.GenericTypographic);
        var figures = new List<GraphicsPath>();
        using (var iterator = new GraphicsPathIterator(art))
        {
            bool closed;
            var figure = new GraphicsPath();
            while (iterator.NextSubpath(figure, out closed) > 0) { figures.Add(figure); figure = new GraphicsPath(); }
            figure.Dispose();
        }
        var outer = new GraphicsPath(FillMode.Winding);
        foreach (var figure in figures)
        {
            bool inside = false;
            PointF first = figure.PathPoints[0];
            foreach (var other in figures) if (other != figure && other.IsVisible(first)) { inside = true; break; }
            if (!inside) outer.AddPath(figure, false);
        }
        foreach (var figure in figures) figure.Dispose();
        var layers = new List<KeyValuePair<GraphicsPath, Color>>();
        layers.Add(new KeyValuePair<GraphicsPath, Color>(outer, fill));
        layers.Add(new KeyValuePair<GraphicsPath, Color>(art, Color.FromArgb(235, 40, 32, 28)));
        return layers;
    }

    /** One glyph's outline in pixels of the EM-sized font, y down, from the baseline at the pen's start. */
    GraphicsPath Outline(int glyph)
    {
        var path = new GraphicsPath(FillMode.Winding); // TrueType fills by winding
        var metrics = new HandNative.GLYPHMETRICS();
        var identity = new HandNative.MAT2(); identity.m11 = 0x10000; identity.m22 = 0x10000;
        const uint NATIVE_UNHINTED_BY_INDEX = 2 | 0x80 | 0x100; // GGO_NATIVE | GGO_GLYPH_INDEX | GGO_UNHINTED
        uint size = HandNative.GetGlyphOutlineW(dc, (uint)glyph, NATIVE_UNHINTED_BY_INDEX, out metrics, 0, null, ref identity);
        if (size == 0 || size == 0xFFFFFFFF) return path;
        var data = new byte[size];
        if (HandNative.GetGlyphOutlineW(dc, (uint)glyph, NATIVE_UNHINTED_BY_INDEX, out metrics, size, data, ref identity) == 0xFFFFFFFF) return path;
        // Every size in the data is checked against what is there: a contour that claims more than the buffer holds, or
        // nothing at all, ends the outline rather than reading past it or going round forever.
        for (int at = 0; at + 16 <= data.Length; )
        {
            int claimed = BitConverter.ToInt32(data, at); // a TTPOLYGONHEADER: its size, its type, the contour's first point
            if (claimed < 16 || claimed > data.Length - at) break;
            int end = at + claimed;
            PointF start = Fixed(data, at + 8), pen = start;
            path.StartFigure();
            for (int curve = at + 16; curve + 4 <= end; )
            {
                int kind = BitConverter.ToUInt16(data, curve), count = BitConverter.ToUInt16(data, curve + 2), points = curve + 4;
                if (points + 8 * count > end) break;
                if (kind == 1) // TT_PRIM_LINE
                    for (int i = 0; i < count; i++) { PointF next = Fixed(data, points + 8 * i); path.AddLine(pen, next); pen = next; }
                else if (kind == 2) // TT_PRIM_QSPLINE: between two control points lies a point on the curve, halfway
                    for (int i = 0; i < count - 1; i++)
                    {
                        PointF control = Fixed(data, points + 8 * i), after = Fixed(data, points + 8 * (i + 1));
                        PointF next = i == count - 2 ? after : new PointF((control.X + after.X) / 2, (control.Y + after.Y) / 2);
                        path.AddBezier(pen, Toward(pen, control), Toward(next, control), next);
                        pen = next;
                    }
                else if (kind == 3) // TT_PRIM_CSPLINE
                    for (int i = 0; i + 2 < count; i += 3) { PointF next = Fixed(data, points + 8 * (i + 2)); path.AddBezier(pen, Fixed(data, points + 8 * i), Fixed(data, points + 8 * (i + 1)), next); pen = next; }
                curve = points + 8 * count;
            }
            if (pen != start) path.AddLine(pen, start);
            path.CloseFigure();
            at = end;
        }
        return path;
    }

    /** A quadratic curve's control point as a cubic's: two thirds of the way from the end to it. */
    static PointF Toward(PointF end, PointF control) { return new PointF(end.X + (control.X - end.X) * 2 / 3, end.Y + (control.Y - end.Y) * 2 / 3); }
    static PointF Fixed(byte[] b, int i) { return new PointF(BitConverter.ToInt32(b, i) / 65536f, -BitConverter.ToInt32(b, i + 4) / 65536f); }

    /** The font's glyph for a character, from its format 12 map, which covers every plane. */
    int GlyphOf(int codepoint)
    {
        if (!Has(cmap, 0, 4)) return -1;
        for (int i = 0, n = U16(cmap, 2); i < n && Has(cmap, 4 + 8 * i, 8); i++)
        {
            int at = U32(cmap, 4 + 8 * i + 4);
            if (!Has(cmap, at, 16) || U16(cmap, at) != 12) continue;
            for (int g = 0, groups = U32(cmap, at + 12); g < groups; g++)
            {
                int group = at + 16 + 12 * g;
                if (!Has(cmap, group, 12)) break;
                if (codepoint >= U32(cmap, group) && codepoint <= U32(cmap, group + 4)) return U32(cmap, group + 8) + codepoint - U32(cmap, group);
            }
        }
        return -1;
    }

    byte[] Table(string tag)
    {
        uint name = (uint)(tag[0] | tag[1] << 8 | tag[2] << 16 | tag[3] << 24);
        uint size = HandNative.GetFontData(dc, name, 0, null, 0);
        if (size == 0 || size == 0xFFFFFFFF) return null;
        var data = new byte[size];
        return HandNative.GetFontData(dc, name, 0, data, size) == size ? data : null;
    }
    static int U16(byte[] b, int i) { return b[i] << 8 | b[i + 1]; }
    static int U32(byte[] b, int i) { return b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]; }
    /** Whether the table has `length` bytes at `at`: an offset read from it may point anywhere, or be negative, read as a signed number. */
    static bool Has(byte[] b, int at, int length) { return b != null && at >= 0 && at <= b.Length - length; }
}

class HandWindow : Form
{
    const double LINGER_MS = 1400, READ_MS = 40, IDLE_MS = 33;

    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly HandFigure figure = new HandFigure();
    readonly StreamWriter stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    readonly string dump = Environment.GetEnvironmentVariable("HANDS_HAND_DUMP"); // a PNG of each new pose, for checking the drawing: captures leave the hand out
    readonly bool recordable = Environment.GetEnvironmentVariable("HANDS_RECORDABLE") == "1"; // for demos: in screen recordings, but for the agent's own captures of the screen

    static readonly string[] RESTING = { "think", "done", "wait", "stop" }; // the poses of a hand between actions, or at the end of its run

    IntPtr target = IntPtr.Zero; // the window ridden, or none: then the hand is a spot on a display, above everything
    double[] origin = { 0, 0 };
    bool riding, seen, shown, hovered, topmost, dumpPending;
    bool away; // riding a display with nothing to do there: faded from it until its next action (Linger)
    double read = -1e9, leaving = -1e9, drew = -1e9, reported; // when the target was last read, the agent left, a frame was drawn; the scale last told to hand.ts
    string drawn = ""; // what the bitmap shows, so that a frame that changes nothing costs nothing
    int pushed = -1; // the window's alpha as last pushed: it changes without the picture as the hand comes into view or goes
    int atX = int.MinValue, atY = int.MinValue;
    IntPtr memory = IntPtr.Zero, section = IntPtr.Zero, unselected = IntPtr.Zero;
    Bitmap canvas; // drawn by GDI+ straight into the DIB section that UpdateLayeredWindow reads

    public HandWindow()
    {
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual; Text = "hand";
        SetBounds(-100, -100, 1, 1);
        stdout.AutoFlush = true;
        figure.Calm = !Animating();
    }
    protected override CreateParams CreateParams
    {
        get { CreateParams p = base.CreateParams; p.ExStyle |= HandNative.WS_EX_LAYERED | HandNative.WS_EX_TRANSPARENT | HandNative.WS_EX_TOOLWINDOW | HandNative.WS_EX_NOACTIVATE; return p; }
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (!recordable) HandNative.SetWindowDisplayAffinity(Handle, HandNative.WDA_EXCLUDEFROMCAPTURE); // out of every capture, always: a shy cue is answered at once
    }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == HandNative.WM_MOUSEACTIVATE) { m.Result = (IntPtr)HandNative.MA_NOACTIVATE; return; } // a click on the hand never takes the user out of their app
        if (m.Msg == HandNative.WM_LBUTTONDOWN) Say("click"); // hand.ts hands it to the agent, which pauses the hand where it is
        if (m.Msg == HandNative.WM_SETTINGCHANGE) figure.Calm = !Animating();
        base.WndProc(ref m);
    }

    /** A line for hand.ts. The agent may have gone first, taking its end of the pipe with it: then nobody is left to tell. */
    void Say(string line)
    {
        try { stdout.Write(line + "\n"); }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
    }

    /** Whether the system animates (Settings, Accessibility, Animation effects), as the panel's page reads prefers-reduced-motion. */
    static bool Animating()
    {
        bool on;
        return !HandNative.SystemParametersInfo(HandNative.SPI_GETCLIENTAREAANIMATION, 0, out on, 0) || on;
    }

    double Now() { return clock.Elapsed.TotalMilliseconds; }

    // ------------------------------------------------------------------ cues

    public void Play(string line)
    {
        Dictionary<string, object> cue;
        try { cue = HandJson.Parse(line) as Dictionary<string, object>; } catch (Exception error) { Hand.Tell("hand: " + error.Message); return; }
        if (cue == null) return;
        // hand.ts hears that a seat cue is on show: a borrow that waits for this never clicks on its own hand. It is
        // answered whatever became of it, so that the answers stay in step with the cues.
        try { Apply(cue, Now()); }
        finally { if (cue.ContainsKey("seat")) Say("seat"); }
    }

    void Apply(Dictionary<string, object> cue, double now)
    {
        object value;
        if (cue.TryGetValue("color", out value) && value is List<object> && ((List<object>)value).Count >= 3)
        {
            var rgb = (List<object>)value;
            figure.Tint = Color.FromArgb(Channel(rgb[0]), Channel(rgb[1]), Channel(rgb[2]));
            figure.Tinted = true;
        }
        if (cue.TryGetValue("shy", out value) && value is bool) Shy((bool)value);
        if (cue.TryGetValue("subject", out value) && value is Dictionary<string, object>) Ride((Dictionary<string, object>)value, now);
        if (cue.TryGetValue("seat", out value) && value is Dictionary<string, object>)
        {
            var seat = (Dictionary<string, object>)value;
            object state, why;
            figure.Borrow(seat.TryGetValue("state", out state) && state is string ? (string)state : "", seat.TryGetValue("why", out why) && why is string ? (string)why : "", now);
            read = -1e9; // the stacking changes now, not at the next read
            // The pointer is the hand's own from here on: its press must reach the window under it. A hand the user's
            // pointer left hovered while it waited lets clicks through now, not at the next frame.
            if (figure.Seat == "holding") Hittable(false, now);
        }
        if (cue.ContainsKey("name") || cue.ContainsKey("label"))
            figure.Label(cue.TryGetValue("name", out value) ? value as string : null, cue.TryGetValue("label", out value) ? value as string : null, now);
        if (cue.TryGetValue("pose", out value) && value is string)
        {
            double count = cue.TryGetValue("count", out value) && value is double ? (double)value : 1;
            double[] swipe = cue.TryGetValue("swipe", out value) ? Pair(value) : new double[] { 0, -1 };
            figure.Strike((string)cue["pose"], count, swipe, now);
            dumpPending = dump != null;
        }
        if (cue.TryGetValue("at", out value) && value is List<object>)
            figure.Glide(Pair(value), cue.TryGetValue("ms", out value) && value is double ? (double)value : 0, now, cue.ContainsKey("subject") || !shown); // a new subject is jumped to, not travelled to
        Linger(now);
        Frame();
    }

    static int Channel(object v) { return Math.Max(0, Math.Min(255, (int)Math.Round((v is double ? (double)v : 0) * 255))); }
    static double[] Pair(object v)
    {
        var list = v as List<object>;
        if (list == null || list.Count < 2) return new double[] { 0, 0 };
        return new double[] { list[0] is double ? (double)list[0] : 0, list[1] is double ? (double)list[1] : 0 };
    }

    /** Leave captures of the screen, or come back into them. Only a recordable hand is ever in them: any other answers at once. */
    void Shy(bool shy)
    {
        if (recordable)
        {
            HandNative.SetWindowDisplayAffinity(Handle, shy ? HandNative.WDA_EXCLUDEFROMCAPTURE : HandNative.WDA_NONE);
            if (shy) HandNative.DwmFlush(); // the screen has been composed without the hand once before the capture is told to go
        }
        if (shy) Say("");
    }

    /**
     * Ride a window, or a spot on a display. The hand is not owned by the window: an owned window is destroyed with its
     * owner, and the hand must outlive a window that closes, to ride the next one. It is stacked by hand instead (Stack).
     */
    void Ride(Dictionary<string, object> subject, double now)
    {
        object value;
        IntPtr window = subject.TryGetValue("window", out value) && value is double ? new IntPtr((long)(double)value) : IntPtr.Zero;
        if (subject.TryGetValue("origin", out value)) origin = Pair(value);
        if (!riding || window != target) figure.Appear(now); // the hand comes up over its new subject
        riding = true;
        target = window;
        read = -1e9;
    }

    public void Depart()
    {
        if (!shown) { Application.Exit(); return; }
        leaving = Now();
        if (!away) figure.Leave(leaving + LINGER_MS); // its last pose stays up long enough to be seen; one already fading from a display is let go on
    }

    /**
     * A hand riding a spot on a display rather than a window is above everything there, over whatever the user has open,
     * so it stays only while it acts: a look at the user's screen, a hello. Back at rest, or at the end of its run, it
     * fades from the display (still riding it), and comes back for its next action there, or when it rides a window.
     */
    void Linger(double now)
    {
        bool rest = riding && target == IntPtr.Zero && figure.Seat.Length == 0 && Array.IndexOf(RESTING, figure.Pose) >= 0;
        if (rest == away) return;
        away = rest;
        if (away) figure.Leave(now); else figure.Appear(now);
    }

    // ------------------------------------------------------------------ frames

    public void Frame()
    {
        if (!riding || IsDisposed) return;
        double now = Now();
        if (leaving > 0 && figure.Gone(now)) { Close(); Application.Exit(); return; }
        if (away && figure.Gone(now))
        {
            if (shown) { HandNative.ShowWindow(Handle, HandNative.SW_HIDE); shown = false; }
            return; // faded from the display it rides: nothing is drawn until its next action there
        }
        if (now - read >= READ_MS)
        {
            read = now;
            bool was = seen;
            seen = Read(now);
            if (seen && !was && !away) figure.Appear(now); // back from minimized, from another desktop, or from off the screens
        }
        if (!seen)
        {
            if (shown) { HandNative.ShowWindow(Handle, HandNative.SW_HIDE); shown = false; }
            return; // nothing is drawn for a hand that cannot be seen
        }

        double[] at = figure.Position(now);
        int x = (int)Math.Round(origin[0] + at[0]) - figure.TouchX, y = (int)Math.Round(origin[1] + at[1]) - figure.TouchY;
        Hover(x, y, now);
        if (shown && !figure.Busy(now) && now - drew < IDLE_MS) { Place(x, y); return; } // a resting pose is drawn at half the rate

        // The alpha is part of what a frame shows: a hand coming back into view is pushed at none, and with the system's
        // animations off nothing else about it changes, so a picture that stays the same is pushed again as it fades in.
        string key = figure.Key(now);
        int alpha = Math.Max(0, Math.Min(255, (int)Math.Round(figure.Opacity(now) * 255)));
        if (key != drawn || !shown)
        {
            drawn = key;
            drew = now;
            using (var g = Graphics.FromImage(canvas)) figure.Draw(g, now);
            if (dumpPending) { dumpPending = false; try { canvas.Save(dump, ImageFormat.Png); } catch (Exception) { } }
            Push(x, y, (byte)alpha);
        }
        else if (alpha != pushed) Push(x, y, (byte)alpha);
        else Place(x, y);
        if (!shown) { HandNative.ShowWindow(Handle, HandNative.SW_SHOWNOACTIVATE); shown = true; } // after its pixels are in place, so it never shows a stale frame
    }

    /** Where the target is and whether it can be seen, the scale of the display under the hand, and the stacking. */
    bool Read(double now)
    {
        if (target != IntPtr.Zero)
        {
            HandNative.RECT frame;
            int cloaked;
            if (!HandNative.IsWindow(target) || HandNative.DwmGetWindowAttribute(target, HandNative.DWMWA_EXTENDED_FRAME_BOUNDS, out frame, 16) != 0) return false; // closed: hidden until a cue gives the hand another window
            origin[0] = frame.left; origin[1] = frame.top;
            if (!HandNative.IsWindowVisible(target) || HandNative.IsIconic(target)) return false;
            if (HandNative.DwmGetWindowAttribute(target, HandNative.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return false; // on another desktop: the hand shows again when the user goes there
            // Parked off every screen (windows.ts park): the hand and its pill go with it, and come back when it does,
            // rather than hang a sliver of pill over the edge of the last display.
            if (HandNative.MonitorFromRect(ref frame, HandNative.MONITOR_DEFAULTTONULL) == IntPtr.Zero) return false;
        }
        double[] at = figure.Position(now);
        var point = new HandNative.POINT(); point.x = (int)Math.Round(origin[0] + at[0]); point.y = (int)Math.Round(origin[1] + at[1]);
        uint dpi, dpiY;
        if (HandNative.GetDpiForMonitor(HandNative.MonitorFromPoint(point, HandNative.MONITOR_DEFAULTTONEAREST), 0, out dpi, out dpiY) != 0) dpi = 144;
        if (figure.Rescale(dpi) || canvas == null) Allocate();
        if (figure.PixelsPerPoint != reported) Say("scale " + (reported = figure.PixelsPerPoint).ToString(CultureInfo.InvariantCulture)); // hand.ts times its glides in points
        Stack();
        return true;
    }

    /**
     * Keep the hand right above its window, so that whatever covers the window covers the hand; above everything while it
     * waits for the seat or holds it, and when it rides a display rather than a window, for as long as it acts there (Linger).
     */
    void Stack()
    {
        bool top = figure.Seat.Length > 0 || target == IntPtr.Zero || Topmost(target);
        const uint QUIET = HandNative.SWP_NOMOVE | HandNative.SWP_NOSIZE | HandNative.SWP_NOACTIVATE;
        if (top)
        {
            // Asked again while the seat is held, should another window have come up over the hand since.
            if (!topmost || (figure.Seat == "holding" && HandNative.GetWindow(Handle, HandNative.GW_HWNDPREV) != IntPtr.Zero)) HandNative.SetWindowPos(Handle, HandNative.HWND_TOPMOST, 0, 0, 0, 0, QUIET);
            topmost = true;
            return;
        }
        if (topmost) { HandNative.SetWindowPos(Handle, HandNative.HWND_NOTOPMOST, 0, 0, 0, 0, QUIET); topmost = false; }
        IntPtr above = HandNative.GetWindow(target, HandNative.GW_HWNDPREV);
        if (above == Handle) return;
        HandNative.SetWindowPos(Handle, above == IntPtr.Zero || Topmost(above) ? HandNative.HWND_TOP : above, 0, 0, 0, 0, QUIET); // below the window above it: right above it
    }

    static bool Topmost(IntPtr window) { return (HandNative.GetWindowLong(window, HandNative.GWL_EXSTYLE) & HandNative.WS_EX_TOPMOST) != 0; }

    /**
     * The window lets every click through, except while the mouse is on the hand or its tag and nothing covers them: then
     * it takes them, so the hand can be clicked, and swells a little to say so. A hand waiting for the seat can be clicked
     * too, which is how the user says not now; one holding it cannot: the pointer is the hand's own then, and its press
     * must reach the window under it. Nor can a hand riding a spot on a display: it lies over whatever the user has there,
     * where a click meant for their own window must not be taken.
     */
    void Hover(int x, int y, double now)
    {
        HandNative.POINT cursor;
        HandNative.GetCursorPos(out cursor);
        Hittable(leaving < 0 && target != IntPtr.Zero && figure.Seat != "holding" && figure.Hits(cursor.x - x, cursor.y - y) && Uncovered(cursor), now);
    }

    void Hittable(bool over, double now)
    {
        if (over == hovered) return;
        hovered = over;
        figure.Hover(over, now);
        int ex = HandNative.GetWindowLong(Handle, HandNative.GWL_EXSTYLE);
        HandNative.SetWindowLong(Handle, HandNative.GWL_EXSTYLE, over ? ex & ~HandNative.WS_EX_TRANSPARENT : ex | HandNative.WS_EX_TRANSPARENT);
    }

    bool Uncovered(HandNative.POINT cursor)
    {
        if (topmost) return true;
        IntPtr under = HandNative.GetAncestor(HandNative.WindowFromPoint(cursor), HandNative.GA_ROOT);
        return under == Handle || under == target;
    }

    /** One DIB section, as large as the figure, made once for each scale: GDI+ draws into its bits and UpdateLayeredWindow shows them. */
    void Allocate()
    {
        if (canvas != null)
        {
            canvas.Dispose();
            HandNative.SelectObject(memory, unselected);
            HandNative.DeleteObject(section);
        }
        if (memory == IntPtr.Zero) memory = HandNative.CreateCompatibleDC(IntPtr.Zero);
        var header = new HandNative.BITMAPINFOHEADER();
        header.size = 40; header.width = figure.Width; header.height = -figure.Height; header.planes = 1; header.bitCount = 32; // top-down, as a GDI+ bitmap's rows are
        IntPtr bits;
        section = HandNative.CreateDIBSection(memory, ref header, 0, out bits, IntPtr.Zero, 0);
        unselected = HandNative.SelectObject(memory, section);
        canvas = new Bitmap(figure.Width, figure.Height, figure.Width * 4, PixelFormat.Format32bppPArgb, bits);
        drawn = "";
    }

    /** Position, size and pixels in one call: the window is what the bitmap shows, alpha and all. */
    void Push(int x, int y, byte alpha)
    {
        var at = new HandNative.POINT(); at.x = x; at.y = y;
        var size = new HandNative.SIZE(); size.cx = figure.Width; size.cy = figure.Height;
        var zero = new HandNative.POINT();
        var blend = new HandNative.BLENDFUNCTION(); blend.op = 0; blend.flags = 0; blend.alpha = alpha; blend.format = 1; // AC_SRC_OVER, AC_SRC_ALPHA
        HandNative.UpdateLayeredWindow(Handle, IntPtr.Zero, ref at, ref size, memory, ref zero, 0, ref blend, 2); // ULW_ALPHA
        atX = x; atY = y; pushed = alpha;
    }

    void Place(int x, int y)
    {
        if (x == atX && y == atY) return;
        HandNative.SetWindowPos(Handle, IntPtr.Zero, x, y, 0, 0, HandNative.SWP_NOSIZE | HandNative.SWP_NOZORDER | HandNative.SWP_NOACTIVATE);
        atX = x; atY = y;
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
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_TOPMOST = 0x8, WS_EX_LAYERED = 0x80000, WS_EX_NOACTIVATE = 0x08000000;
    public const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOZORDER = 4, SWP_NOACTIVATE = 0x10, GW_HWNDPREV = 3, GA_ROOT = 2, MONITOR_DEFAULTTONULL = 0, MONITOR_DEFAULTTONEAREST = 2;
    public static readonly IntPtr HWND_TOP = IntPtr.Zero, HWND_TOPMOST = new IntPtr(-1), HWND_NOTOPMOST = new IntPtr(-2);
    public const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4, WM_SETTINGCHANGE = 0x1A, WM_MOUSEACTIVATE = 0x21, WM_LBUTTONDOWN = 0x201, MA_NOACTIVATE = 3, DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
    public const uint SPI_GETCLIENTAREAANIMATION = 0x1042;
    public const uint WDA_NONE = 0, WDA_EXCLUDEFROMCAPTURE = 0x11;

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct BLENDFUNCTION { public byte op, flags, alpha, format; }
    [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFOHEADER { public int size, width, height; public short planes, bitCount; public int compression, sizeImage, xPelsPerMeter, yPelsPerMeter, clrUsed, clrImportant; }
    [StructLayout(LayoutKind.Sequential)] public struct GLYPHMETRICS { public uint blackBoxX, blackBoxY; public int originX, originY; public short cellIncX, cellIncY; }
    [StructLayout(LayoutKind.Sequential)] public struct MAT2 { public int m11, m12, m21, m22; } // FIXED 16.16 each

    [DllImport("user32.dll", SetLastError = true)] public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr dstDc, ref POINT dst, ref SIZE size, IntPtr srcDc, ref POINT src, int key, ref BLENDFUNCTION blend, int flags);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER header, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateFontW(int height, int width, int escapement, int orientation, int weight, uint italic, uint underline, uint strikeOut, uint charSet, uint outPrecision, uint clipPrecision, uint quality, uint pitchAndFamily, string face);
    [DllImport("gdi32.dll")] public static extern uint GetFontData(IntPtr dc, uint table, uint offset, byte[] buffer, uint size);
    [DllImport("gdi32.dll")] public static extern uint GetGlyphOutlineW(IntPtr dc, uint glyph, uint format, out GLYPHMETRICS metrics, uint size, byte[] buffer, ref MAT2 matrix);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref RECT rect, uint flags);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll", SetLastError = true)] public static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)] public static extern int SetWindowLong(IntPtr hwnd, int index, int value);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
    [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, out bool value, uint ini);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
    [DllImport("dwmapi.dll")] public static extern int DwmFlush();
    [DllImport("dcomp.dll")] public static extern uint DCompositionWaitForCompositorClock(uint count, IntPtr[] handles, uint timeoutMs);
    [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
}
