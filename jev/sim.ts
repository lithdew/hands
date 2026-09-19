// sim.ts — a small simulated web, so whole tasks can be evaluated without a desktop.
//
// tasks.eval.ts runs real Jev (and the real LLM) against these pages. Each app
// is a state machine that renders the same `Observation` observe.ts produces,
// with the clutter a real page has (navigation, promotions, twins), and reacts
// to the `Action`s cua.ts performs. Nothing here knows what the task is: a wrong
// click goes somewhere wrong, an unresolved recipient fails on Send.
//
//   const world = new World();
//   world.open("https://mail.google.com/");
//   world.look()            -> Observation
//   world.act(action)       click / type / key / scroll / wait / select
//   world.gmail.sent        what was committed, for the task's success check
//
// Deep links work the way the real sites' do (Gmail `?view=cm&to=&su=&body=`,
// OpenTable `/s?term=&covers=&dateTime=`), so recipes.ts can be measured too.

import type { Hand } from "../desktop";
import type { Action } from "./cua";
import type { Observation, UiElement } from "./observe";

// ---------------------------------------------------------------- types

export const SIM_HAND: Hand = { id: 1, pid: 1, display: "wayland-1", width: 1280, height: 800 };
/** The day every simulated task happens on: a Saturday. */
export const SIM_TODAY = new Date(2026, 8, 19, 12, 0, 0);

type Zone = "top" | "left" | "main" | "dialog" | "bottom";
export type Spec = {
  key: string;
  role: string;
  name: string;
  value?: string;
  editable?: boolean;
  within?: string;
  zone?: Zone;
  /** A native <select>: its options can be read, and set without opening it. */
  options?: string[];
};
type Page = { title: string; url: string; specs: Spec[]; texts: string[] };

/** `select` sets a native dropdown directly. cua.ts has no such move; screen.ts does. */
export type SimAction = Action | { kind: "select"; target: UiElement; option: string };

export const CONTACTS = [
  { name: "Sam Rivera", email: "sam.rivera@example.com" },
  { name: "Samantha Lee", email: "samantha.lee@example.com" },
  { name: "Mom", email: "linda.li@example.com" },
  { name: "Alex Chen", email: "alex.chen@example.com" },
  { name: "Priya Natarajan", email: "priya.n@example.com" },
  { name: "Jordan Blake", email: "jordan.blake@example.com" },
  { name: "Dana Whitfield", email: "dana.w@example.com" },
  { name: "Dr. Patel's Office", email: "frontdesk@patelclinic.example.com" },
] as const;

// ---------------------------------------------------------------- dates

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shortDate = (d: Date) => `${MONTHS[d.getMonth()]!.slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}`;
const longDate = (d: Date) => `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);
/** Minutes since midnight <-> "7:00 PM". */
export const clock = (m: number) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${m >= 720 ? "PM" : "AM"}`;
const minutesOf = (label: string) => {
  const [, h, m, half] = /^(\d+):(\d+) (AM|PM)$/.exec(label)!;
  return (Number(h) % 12) * 60 + Number(m) + (half === "PM" ? 720 : 0);
};

// ---------------------------------------------------------------- apps

abstract class App {
  focus: string | null = null;
  constructor(protected go: (url: string) => void) {}
  abstract page(): Page;
  abstract click(key: string): void;
  /** Typing replaces what the field holds, as win/jev.ts `perform` does. */
  abstract setField(key: string, text: string): void;
  enter(): void {}
  tab(): void {}
  select(_key: string, _option: string): void {}
}

const link = (key: string, name: string, zone: Zone = "main", within?: string): Spec => ({ key, role: "link", name, zone, within });
const button = (key: string, name: string, zone: Zone = "main", within?: string): Spec => ({ key, role: "button", name, zone, within });
const field = (key: string, name: string, value: string, zone: Zone = "main", within?: string): Spec => ({ key, role: "text field", name, value, editable: true, zone, within });

// ---- Gmail

/** Two signed-in accounts, as Gmail has them at /u/0 and /u/1. The first is where a plain mail.google.com lands. */
export const MAILBOXES: Record<string, string[]> = {
  "chi@example.com": [
    "Sam Rivera, Re: Q3 planning, Sounds good. See you at the meeting, 9:12 AM",
    "Alex Chen, Deck for Monday, Can you take a look at slide 4 before we send it, 8:40 AM",
    "OpenTable, Your reservation at Bella Napoli is confirmed, Sep 17",
    "Dr. Patel's Office, Appointment reminder, Your appointment is on Tuesday at 3:00 PM, Sep 17",
    "Dana Whitfield, Lunch next week?, Are you free Thursday, Sep 16",
    "GitHub, [puk] Pull request #12 opened by teammate, Sep 16",
    "Mom, Photos from the weekend, Sep 15",
    "Jordan Blake, Invoice 2291, Attached is the invoice for August, Sep 14",
  ],
  "chi.li@u.northwestern.edu": [
    "Ananth Rao, Lab meeting moved to Thursday, We are in room 3.14 at two, please confirm, 10:02 AM",
    "Registrar, Fall enrollment opens Monday, Sep 18",
    "Prof. Okafor, Reading for week 2, Chapters 3 and 4, Sep 17",
    "Northwestern IT, Password expires in 14 days, Sep 16",
    "Ananth Rao, Draft of the poster, Attached is the first draft, Sep 12",
    "Career Services, Resume workshop, Sep 11",
  ],
};
const DEFAULT_ACCOUNT = Object.keys(MAILBOXES)[0]!;

class Gmail extends App {
  account = DEFAULT_ACCOUNT;
  compose: { chips: string[]; raw: string; subject: string; body: string; suggest: (typeof CONTACTS)[number][] } | null = null;
  sent: { to: string[]; subject: string; body: string; account: string }[] = [];
  /** The search that is showing, and the message that is open (an index into the account's mailbox). */
  query: string | null = null; message: number | null = null;
  reply: { body: string } | null = null;
  replies: { to: string; body: string; account: string }[] = [];
  error: string | null = null;
  justSent = false;

  open(url: URL) {
    this.compose = null; this.error = null; this.justSent = false; this.query = null; this.message = null; this.reply = null;
    // authuser picks the account. An address that is not signed in lands in the default one, as Google's chooser would after a click.
    const asked = url.searchParams.get("authuser")?.toLowerCase(), index = /\/u\/(\d)\//.exec(url.pathname)?.[1];
    this.account = asked && asked in MAILBOXES ? asked : index && Object.keys(MAILBOXES)[Number(index)] ? Object.keys(MAILBOXES)[Number(index)]! : asked ? DEFAULT_ACCOUNT : url.searchParams.has("authuser") || index ? DEFAULT_ACCOUNT : DEFAULT_ACCOUNT;
    const search = /^#search\/(.+)$/.exec(url.hash);
    if (search) this.query = decodeURIComponent(search[1]!.replace(/\+/g, " "));
    if (url.searchParams.get("view") === "cm") {
      this.compose = { chips: [], raw: "", subject: url.searchParams.get("su") ?? "", body: url.searchParams.get("body") ?? "", suggest: [] };
      const to = url.searchParams.get("to");
      if (to) this.setField("to", to);
      this.focus = "body";
    }
  }

  private rows(): { row: string; at: number }[] {
    const all = MAILBOXES[this.account]!.map((row, at) => ({ row, at }));
    if (this.query === null) return all;
    const from = /from:\(?([^)]+?)\)?(?:\s|$)/i.exec(this.query)?.[1]?.toLowerCase(), words = this.query.replace(/from:\(?[^)]+?\)?(?:\s|$)/i, "").toLowerCase().split(/\s+/).filter((w) => w && !/^(or|and)$/.test(w));
    return all.filter(({ row }) => (!from || row.split(",")[0]!.toLowerCase().includes(from)) && words.every((w) => row.toLowerCase().includes(w.replace(/[()]/g, ""))));
  }

  page(): Page {
    const specs: Spec[] = [
      button("menu", "Main menu", "top"), link("home", "Gmail", "top"), field("search", "Search mail", this.query ?? "", "top", "search"), button("search_options", "Show search options", "top"),
      button("support", "Support", "top"), button("settings", "Settings", "top"), button("apps", "Google apps", "top"), button("account", `Google Account: Chi Li (${this.account})`, "top"),
      button("compose", "Compose", "left"), link("inbox", "Inbox 3", "left", "navigation"), link("starred", "Starred", "left", "navigation"), link("snoozed", "Snoozed", "left", "navigation"),
      link("sent", "Sent", "left", "navigation"), link("drafts", "Drafts 1", "left", "navigation"), link("more", "More", "left", "navigation"), button("new_label", "Create new label", "left"),
    ];
    const texts: string[] = [];
    let title = `Inbox (3) - ${this.account} - Gmail`;
    if (this.message !== null) {
      const [from, subject, ...rest] = MAILBOXES[this.account]![this.message]!.split(", ");
      title = `${subject} - ${this.account} - Gmail`;
      specs.push(button("back", this.query === null ? "Back to Inbox" : "Back to Search results", "main"), button("archive", "Archive", "main"), button("delete", "Delete", "main"), button("mark_unread", "Mark as unread", "main"),
        button("reply", "Reply", "main", subject), button("forward", "Forward", "main", subject), button("more_message", "More", "main", subject));
      texts.push(subject!, `From: ${from}`, rest.join(", "));
      if (this.reply) specs.push(field("reply_body", "Message Body", this.reply.body, "main", "Reply"), button("reply_send", "Send", "main", "Reply"), button("reply_discard", "Discard draft", "main", "Reply"));
    } else {
      const rows = this.rows();
      if (this.query !== null) title = `Search results - ${this.account} - Gmail`;
      specs.push({ key: "tab_primary", role: "tab", name: "Primary", zone: "main" }, { key: "tab_promotions", role: "tab", name: "Promotions", zone: "main" }, button("refresh", "Refresh", "main"), button("select_all", "Select", "main"),
        ...rows.map(({ row, at }) => link(`mail_${at}`, row, "main", this.query === null ? "inbox" : "search results")));
      texts.push(this.query === null ? "Inbox" : `Search results for ${JSON.stringify(this.query)}`, rows.length ? `1-${rows.length} of ${rows.length}` : "No messages matched your search.");
    }
    if (this.justSent) { specs.push(button("undo", "Undo", "bottom"), link("view_message", "View message", "bottom")); texts.unshift("Message sent"); }
    const c = this.compose;
    if (c) {
      const to = [...c.chips, c.raw].filter(Boolean).join(", ");
      specs.push(
        button("c_minimize", "Minimize", "dialog", "New Message"), button("c_popout", "Pop-out", "dialog", "New Message"), button("c_close", "Save & close", "dialog", "New Message"),
        { ...field("to", "To recipients", to, "dialog", "New Message") }, link("cc", "Add Cc recipients", "dialog", "New Message"), link("bcc", "Add Bcc recipients", "dialog", "New Message"),
        ...c.suggest.map((sg, i) => ({ key: `suggest_${i}`, role: "option", name: `${sg.name} ${sg.email}`, zone: "dialog" as Zone, within: "Contact suggestions" })),
        field("subject", "Subject", c.subject, "dialog", "New Message"), field("body", "Message Body", c.body, "dialog", "New Message"),
        button("send", "Send", "dialog", "New Message"), button("send_options", "More send options", "dialog", "New Message"), button("formatting", "Formatting options", "dialog", "New Message"),
        button("attach", "Attach files", "dialog", "New Message"), button("insert_link", "Insert link", "dialog", "New Message"), button("emoji", "Insert emoji", "dialog", "New Message"),
        button("drive", "Insert files using Drive", "dialog", "New Message"), button("confidential", "Toggle confidential mode", "dialog", "New Message"), button("discard", "Discard draft", "dialog", "New Message"),
      );
      texts.push("New Message");
    }
    if (this.error) { specs.push(button("error_ok", "OK", "dialog", "Error")); texts.unshift(`Error: ${this.error}`); }
    const index = Object.keys(MAILBOXES).indexOf(this.account);
    return { title, url: `https://mail.google.com/mail/u/${index}/#${this.message !== null ? "inbox/message" : this.query !== null ? `search/${encodeURIComponent(this.query)}` : "inbox"}`, specs, texts };
  }

  private resolve() { // leaving the To field: addresses become chips, a bare name stays unresolved
    const c = this.compose, parts = c?.raw.split(/[,;]\s*|\s+/).filter(Boolean) ?? [];
    if (c && parts.length && parts.every((p) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p))) { c.chips.push(...parts); c.raw = ""; }
    if (c) c.suggest = [];
  }

  click(key: string) {
    this.justSent = false;
    const c = this.compose;
    if (key === "error_ok") return void (this.error = null);
    if (key === "compose") { this.compose ??= { chips: [], raw: "", subject: "", body: "", suggest: [] }; this.focus = "to"; return; }
    if (key.startsWith("mail_") && !c) { this.message = Number(key.slice(5)); this.reply = null; return; }
    if (key === "back") { this.message = null; this.reply = null; return; }
    if (key === "inbox" || key === "home") { this.message = null; this.query = null; this.reply = null; return; }
    if (key === "reply" && this.message !== null) { this.reply ??= { body: "" }; this.focus = "reply_body"; return; }
    if (key === "reply_discard") return void (this.reply = null);
    if (key === "reply_send" && this.reply && this.message !== null) {
      if (!this.reply.body.trim()) return void (this.error = "Send this message without text in the body?");
      this.replies.push({ to: MAILBOXES[this.account]![this.message]!.split(", ")[0]!, body: this.reply.body, account: this.account }); this.reply = null; this.justSent = true; return;
    }
    if (!c) return;
    if (key.startsWith("suggest_")) { const sg = c.suggest[Number(key.slice(8))]; if (sg) { c.chips.push(sg.email); c.raw = ""; c.suggest = []; this.focus = "subject"; } return; }
    if (key !== "to") this.resolve();
    if (key === "discard" || key === "c_close") return void (this.compose = null);
    if (key === "send") {
      if (c.raw) return void (this.error = `The address "${c.raw}" in the "To" field was not recognized. Please make sure that all addresses are properly formed.`);
      if (!c.chips.length) return void (this.error = "Please specify at least one recipient.");
      this.sent.push({ to: c.chips, subject: c.subject, body: c.body, account: this.account }); this.compose = null; this.justSent = true;
    }
  }

  setField(key: string, text: string) {
    if (key === "search") return void (this.query = text.trim() || null, this.message = null);
    if (key === "reply_body" && this.reply) return void (this.reply.body = text);
    const c = this.compose;
    if (!c) return;
    if (key !== "to") this.resolve();
    if (key === "to") {
      c.chips = []; c.raw = text.trim();
      const q = c.raw.toLowerCase();
      c.suggest = q && !q.includes("@") ? CONTACTS.filter((p) => p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || p.name.toLowerCase().startsWith(q)) : [];
      if (c.raw.includes("@")) this.resolve();
    } else if (key === "subject") c.subject = text;
    else if (key === "body") c.body = text;
  }

  private pickFirst() { const c = this.compose; if (c && this.focus === "to" && c.suggest.length) this.click("suggest_0"); }
  override enter() { this.pickFirst(); }
  override tab() { this.pickFirst(); }
}

// ---- OpenTable

const RESTAURANTS = [
  { name: "Bella Napoli", cuisine: "Italian", promoted: true, offsets: [0, 15, 30], about: "$$$, 4.6 stars, Midtown" },
  { name: "Prime & Provisions", cuisine: "Steakhouse", promoted: false, offsets: [-30, -15, 30], about: "$$$$, 4.8 stars, Downtown" },
  { name: "Keens Steakhouse", cuisine: "Steakhouse", promoted: false, offsets: [-15, 0, 15], about: "$$$$, 4.7 stars, Garment District" },
  { name: "The Capital Grille", cuisine: "Steakhouse", promoted: false, offsets: [0, 30, 45], about: "$$$$, 4.6 stars, Financial District" },
  { name: "Sakura Sushi House", cuisine: "Japanese", promoted: false, offsets: [0, 15], about: "$$$, 4.5 stars, East Village" },
  { name: "Casa Oaxaca", cuisine: "Mexican", promoted: false, offsets: [-15, 0], about: "$$, 4.4 stars, West Side" },
];
const OT_TIMES = Array.from({ length: 11 }, (_, i) => clock(17 * 60 + i * 30));
const OT_PARTIES = Array.from({ length: 10 }, (_, i) => (i ? `${i + 1} people` : "1 person"));

class OpenTable extends App {
  view: "home" | "results" | "booking" | "confirmed" = "home";
  date = SIM_TODAY; time = "7:00 PM"; party = 2; term = ""; typed = "";
  dropdown: "date" | "time" | "party" | null = null;
  chosen: { restaurant: string; cuisine: string; time: string } | null = null;
  request = ""; occasion = "";
  booked: { restaurant: string; cuisine: string; date: string; time: string; party: number; request: string; occasion: string } | null = null;

  open(url: URL) {
    this.dropdown = null; this.view = "home"; this.chosen = null;
    if (url.pathname.startsWith("/s")) {
      this.view = "results"; this.term = this.typed = url.searchParams.get("term") ?? "";
      const covers = Number(url.searchParams.get("covers")), when = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(url.searchParams.get("dateTime") ?? "");
      if (covers >= 1 && covers <= 10) this.party = covers;
      if (when) { this.date = new Date(Number(when[1]), Number(when[2]) - 1, Number(when[3]), 12); this.time = clock(Number(when[4]) * 60 + Number(when[5])); }
    }
  }

  private searchBar(): Spec[] {
    const specs: Spec[] = [
      { key: "date", role: "dropdown", name: "Date", value: shortDate(this.date), zone: "main", within: "Find a table" },
      { key: "time", role: "dropdown", name: "Time", value: this.time, zone: "main", within: "Find a table", options: OT_TIMES },
      { key: "party", role: "dropdown", name: "Party size", value: OT_PARTIES[this.party - 1]!, zone: "main", within: "Find a table", options: OT_PARTIES },
      field("term", "Location, Restaurant, or Cuisine", this.typed, "main", "Find a table"), button("go", this.view === "home" ? "Let's go" : "Find a table", "main", "Find a table"),
    ];
    if (this.dropdown === "date") specs.push(...Array.from({ length: 14 }, (_, i) => button(`day_${i}`, longDate(addDays(SIM_TODAY, i)), "main", "Calendar")));
    if (this.dropdown === "time") specs.push(...OT_TIMES.map((t, i) => ({ key: `time_${i}`, role: "option", name: t, zone: "main" as Zone, within: "Time options" })));
    if (this.dropdown === "party") specs.push(...OT_PARTIES.map((p, i) => ({ key: `party_${i}`, role: "option", name: p, zone: "main" as Zone, within: "Party size options" })));
    return specs;
  }

  private listed() { return /steak/i.test(this.term) ? RESTAURANTS.filter((r) => r.promoted || r.cuisine === "Steakhouse") : RESTAURANTS; }

  page(): Page {
    const top = [link("logo", "OpenTable", "top"), link("business", "For Businesses", "top"), link("mobile", "Mobile", "top"), link("faq", "FAQs", "top"), button("language", "EN", "top"), button("notifications", "Notifications", "top"), button("profile", "Chi's profile", "top")];
    const footer = [link("f_about", "About Us", "bottom"), link("f_careers", "Careers", "bottom"), link("f_gift", "Gift Cards", "bottom"), link("f_privacy", "Privacy Policy", "bottom"), link("f_terms", "Terms of Use", "bottom")];
    const summary = `${shortDate(this.date)}, ${this.time}, ${OT_PARTIES[this.party - 1]}`;
    if (this.view === "home") {
      return { title: "OpenTable: Restaurants and Restaurant Reservations", url: "https://www.opentable.com/", texts: ["Find your table for any occasion", "Available for dinner now", "Browse by cuisine"],
        specs: [...top, ...this.searchBar(),
          ...RESTAURANTS.map((r, i) => link(`promo_${i}`, `${r.name}, ${r.cuisine}, ${r.about}`, "main", "Available for dinner now")),
          ...["Italian", "Steakhouse", "Sushi", "Mexican", "Seafood", "French"].map((c) => link(`cuisine_${c}`, c, "main", "Browse by cuisine")), ...footer] };
    }
    if (this.view === "results") {
      const base = minutesOf(this.time), shown = this.listed();
      return { title: `${this.term || "Restaurants"} near you - OpenTable`, url: "https://www.opentable.com/s", texts: [`${shown.length} restaurants available for ${summary}`, ...shown.map((r) => `${r.name}: ${r.promoted ? "Promoted. " : ""}${r.cuisine}, ${r.about}`)],
        specs: [...top, ...this.searchBar(),
          ...["Steakhouse", "Italian", "Outdoor seating", "$$$$"].map((f) => ({ key: `filter_${f}`, role: "checkbox", name: f, zone: "left" as Zone, within: "Filters" })),
          ...shown.flatMap((r, i) => [link(`r_${i}`, `${r.name}${r.promoted ? ", Promoted" : ""}, ${r.cuisine}`, "main", r.name), ...r.offsets.map((o) => button(`slot_${i}_${o}`, clock(base + o), "main", r.name))]), ...footer] };
    }
    if (this.view === "booking") {
      return { title: "Complete your reservation - OpenTable", url: "https://www.opentable.com/booking/details", texts: ["You're almost done!", `${this.chosen!.restaurant}: ${shortDate(this.date)}, ${this.chosen!.time}, ${OT_PARTIES[this.party - 1]}`, "We're holding this table for you for 5:00 minutes", "Diner details: Chi Li"],
        specs: [...top, field("phone", "Phone number", "(555) 010-2030", "main", "Diner details"), field("email", "Email", "chi@example.com", "main", "Diner details"),
          { key: "occasion", role: "dropdown", name: "Select an occasion (optional)", value: this.occasion, zone: "main", within: "Diner details", options: ["Birthday", "Anniversary", "Date night", "Business meal", "Celebration"] },
          field("request", "Add a special request (optional)", this.request, "main", "Diner details"), { key: "offers", role: "checkbox", name: "Sign me up to receive dining offers and news", zone: "main", within: "Diner details" },
          button("complete", "Complete reservation", "main"), link("b_terms", "Terms of Use", "main"), link("b_privacy", "Privacy Policy", "main"), ...footer] };
    }
    return { title: "Reservation confirmed - OpenTable", url: "https://www.opentable.com/booking/confirmed", texts: ["Reservation confirmed", `${this.booked!.restaurant}: ${shortDate(this.date)}, ${this.booked!.time}, ${OT_PARTIES[this.party - 1]}`, "Confirmation #84412"],
      specs: [...top, button("add_calendar", "Add to calendar", "main"), button("modify", "Modify", "main"), button("cancel", "Cancel reservation", "main"), link("directions", "Get directions", "main"), ...footer] };
  }

  click(key: string) {
    const was = this.dropdown;
    this.dropdown = null;
    if (key === "logo") return void (this.view = "home");
    if (key === "date" || key === "time" || key === "party") return void (this.dropdown = was === key ? null : key);
    if (key.startsWith("day_")) return void (this.date = addDays(SIM_TODAY, Number(key.slice(4))));
    if (key.startsWith("time_")) return void (this.time = OT_TIMES[Number(key.slice(5))]!);
    if (key.startsWith("party_")) return void (this.party = Number(key.slice(6)) + 1);
    if (key === "go") { this.term = this.typed; this.view = "results"; return; }
    if (key.startsWith("cuisine_")) { this.term = this.typed = key.slice(8); this.view = "results"; return; }
    if (key.startsWith("filter_Steakhouse")) { this.term = this.typed = "Steakhouse"; return; }
    if (key.startsWith("slot_") && this.view === "results") {
      const [, i, o] = key.split("_"), r = this.listed()[Number(i)]!;
      this.chosen = { restaurant: r.name, cuisine: r.cuisine, time: clock(minutesOf(this.time) + Number(o)) }; this.view = "booking"; return;
    }
    if (key === "complete" && this.chosen) { this.booked = { ...this.chosen, date: isoDate(this.date), party: this.party, request: this.request, occasion: this.occasion }; this.view = "confirmed"; }
  }

  setField(key: string, text: string) { if (key === "term") this.typed = text; if (key === "request") this.request = text; }
  override enter() { if (this.focus === "term") this.click("go"); }
  override select(key: string, option: string) {
    if (key === "time" && OT_TIMES.includes(option)) this.time = option;
    if (key === "party" && OT_PARTIES.includes(option)) this.party = OT_PARTIES.indexOf(option) + 1;
    if (key === "occasion") this.occasion = option;
  }
}

// ---- Keep

class Keep extends App {
  editing: { title: string; body: string } | null = null;
  saved: { title: string; body: string }[] = [];
  open() { this.editing = null; }

  page(): Page {
    const specs: Spec[] = [
      button("menu", "Main menu", "top"), link("home", "Keep", "top"), field("search", "Search", "", "top", "search"), button("refresh", "Refresh", "top"), button("list_view", "List view", "top"), button("settings", "Settings", "top"), button("account", "Google Account: Chi Li", "top"),
      link("nav_notes", "Notes", "left", "navigation"), link("nav_reminders", "Reminders", "left", "navigation"), link("nav_labels", "Edit labels", "left", "navigation"), link("nav_archive", "Archive", "left", "navigation"), link("nav_trash", "Trash", "left", "navigation"),
    ];
    if (this.editing) {
      specs.push(field("title", "Title", this.editing.title, "main", "New note"), field("body", "Note", this.editing.body, "main", "New note"), button("pin", "Pin note", "main", "New note"),
        button("remind", "Remind me", "main", "New note"), button("collaborator", "Collaborator", "main", "New note"), button("background", "Background options", "main", "New note"), button("image", "Add image", "main", "New note"),
        button("archive", "Archive", "main", "New note"), button("more", "More", "main", "New note"), button("undo", "Undo", "main", "New note"), button("redo", "Redo", "main", "New note"), button("close", "Close", "main", "New note"));
    } else {
      specs.push(field("take", "Take a note…", "", "main"), button("new_list", "New list", "main"), button("new_drawing", "New note with drawing", "main"), button("new_image", "New note with image", "main"));
    }
    const notes = [...this.saved.map((n) => `${n.title || "Untitled"}: ${n.body}`), "Groceries: eggs, oat milk, coffee", "Wifi password for the office", "Book recommendations from Priya", "Packing list: Lisbon", "Ideas for mom's birthday"];
    specs.push(...notes.map((n, i) => link(`note_${i}`, n.slice(0, 80), "main", "Notes")));
    return { title: "Google Keep", url: "https://keep.google.com/", specs, texts: ["Notes", ...(this.saved.length ? ["Note saved"] : [])] };
  }

  click(key: string) {
    if (key === "take") { this.editing ??= { title: "", body: "" }; this.focus = "body"; return; }
    if (key === "close" && this.editing) { if (this.editing.title || this.editing.body) this.saved.unshift(this.editing); this.editing = null; }
  }
  setField(key: string, text: string) {
    if (key === "take") { this.editing ??= { title: "", body: "" }; this.editing.body = text; this.focus = "body"; }
    else if (this.editing && key === "title") this.editing.title = text;
    else if (this.editing && key === "body") this.editing.body = text;
  }
}

// ---- Messages

const THREADS = [
  { who: "Mom", last: "Are you coming for dinner tonight? We eat at six thirty.", at: "5:42 PM", unread: true, earlier: ["Mom: Dad made his lasagna", "You: Sounds great"] },
  { who: "Alex Chen", last: "can you send me the deck before 3?", at: "1:15 PM", unread: true, earlier: ["You: Working on slide 4 now", "Alex Chen: nice"] },
  { who: "Dr. Patel's Office", last: "Reminder: your appointment is on Tuesday at 3:00 PM. Reply C to confirm.", at: "11:02 AM", unread: false, earlier: [] },
  { who: "48291", last: "Your verification code is 482913", at: "Yesterday", unread: false, earlier: [] },
  { who: "Priya Natarajan", last: "haha ok see you then", at: "Yesterday", unread: false, earlier: ["You: 8 works for me"] },
  { who: "Jordan Blake", last: "Thanks!", at: "Thursday", unread: false, earlier: ["You: Invoice paid"] },
];

class Messages extends App {
  thread: number | null = null;
  draft = "";
  sent: { to: string; text: string }[] = [];
  open() { this.thread = null; this.draft = ""; }

  page(): Page {
    const specs: Spec[] = [button("menu", "Main menu", "top"), link("home", "Messages", "top"), button("settings", "Settings", "top"), button("account", "Google Account: Chi Li", "top"), button("start", "Start chat", "left"),
      ...THREADS.map((t, i) => link(`thread_${i}`, `${t.who}. ${t.last} ${t.at}.${t.unread ? " Unread." : ""}`, "left", "Conversations"))];
    const texts = ["Messages for web"];
    if (this.thread !== null) {
      const t = THREADS[this.thread]!, mine = this.sent.filter((s) => s.to === t.who).map((s) => `You: ${s.text}`);
      specs.push(button("call", "Call", "main", `Conversation with ${t.who}`), button("details", "Conversation details", "main", `Conversation with ${t.who}`), button("attach", "Attach media", "main", `Conversation with ${t.who}`),
        button("emoji", "Emoji", "main", `Conversation with ${t.who}`), field("draft", "Text message", this.draft, "main", `Conversation with ${t.who}`), button("send", "Send SMS message", "main", `Conversation with ${t.who}`));
      texts.push(`Conversation with ${t.who}`, ...t.earlier, `${t.who}: ${t.last}`, ...mine);
    } else texts.push("Select a conversation to start messaging");
    return { title: "Messages for web", url: "https://messages.google.com/web/conversations", specs, texts };
  }

  private send() { if (this.thread !== null && this.draft.trim()) { this.sent.push({ to: THREADS[this.thread]!.who, text: this.draft.trim() }); this.draft = ""; } }
  click(key: string) {
    if (key.startsWith("thread_")) { this.thread = Number(key.slice(7)); this.draft = ""; this.focus = "draft"; }
    else if (key === "send") this.send();
  }
  setField(key: string, text: string) { if (key === "draft") this.draft = text; }
  override enter() { if (this.focus === "draft") this.send(); }
}

// ---- Google, and pages that lead nowhere

const SITES = [
  { url: "https://www.opentable.com/", title: "OpenTable: Restaurants and Restaurant Reservations", words: /table|restaurant|steak|book|reserv|dinner|eat/i },
  { url: "https://mail.google.com/", title: "Gmail: Private and secure email", words: /mail/i },
  { url: "https://keep.google.com/", title: "Google Keep: Notes and lists", words: /note|keep|remind|write/i },
  { url: "https://messages.google.com/web", title: "Messages for web: text from your computer", words: /text|message|sms|reply/i },
  { url: "https://www.yelp.com/", title: "Yelp: Restaurant reviews near you", words: /table|restaurant|steak|dinner|eat/i },
  { url: "https://www.tripadvisor.com/", title: "Tripadvisor: THE 10 BEST Steakhouses", words: /steak|restaurant/i },
  { url: "https://en.wikipedia.org/", title: "Wikipedia, the free encyclopedia", words: /./ },
];

class Google extends App {
  query = ""; typed = "";
  open(url: URL) { this.query = this.typed = url.searchParams.get("q") ?? ""; }
  private hits() { return SITES.filter((s) => s.words.test(this.query)); }
  page(): Page {
    const specs: Spec[] = [link("gmail", "Gmail", "top"), link("images", "Images", "top"), button("apps", "Google apps", "top"), button("account", "Google Account: Chi Li", "top"), field("q", "Search", this.typed, "main", "search"), button("search", "Google Search", "main", "search")];
    if (!this.query) specs.push(button("lucky", "I'm Feeling Lucky", "main", "search"), link("about", "About", "bottom"), link("privacy", "Privacy", "bottom"));
    else specs.push(...this.hits().map((s, i) => link(`hit_${i}`, s.title, "main", "Search results")), link("next", "Next", "bottom"));
    return { title: this.query ? `${this.query} - Google Search` : "Google", url: "https://www.google.com/", specs, texts: this.query ? [`About 1,240,000 results for ${this.query}`] : [] };
  }
  click(key: string) {
    if (key === "gmail") return this.go("https://mail.google.com/");
    if (key === "search") return void (this.query = this.typed);
    if (key.startsWith("hit_")) { const s = this.hits()[Number(key.slice(4))]; if (s) this.go(s.url); }
  }
  setField(key: string, text: string) { if (key === "q") this.typed = text; }
  override enter() { if (this.focus === "q") this.query = this.typed; }
}

class DeadEnd extends App {
  host = "";
  open(url: URL) { this.host = url.hostname; }
  page(): Page {
    return { title: this.host, url: `https://${this.host}/`, texts: [`Welcome to ${this.host}`, "Sign in to continue"],
      specs: [link("home", this.host, "top"), button("signin", "Sign in", "top"), field("search", "Search", "", "main"), link("a", "Top 10 lists", "main"), link("b", "Write a review", "main"), link("c", "Download the app", "main")] };
  }
  click() {}
  setField() {}
}

// ---------------------------------------------------------------- world

const ZONES: Record<Zone, { x: number; y: number; w: number; h: number; across: boolean }> = {
  top: { x: 0, y: 0, w: 1280, h: 70, across: true },
  left: { x: 0, y: 90, w: 240, h: 660, across: false },
  main: { x: 260, y: 90, w: 480, h: 660, across: false },
  dialog: { x: 780, y: 300, w: 480, h: 470, across: false },
  bottom: { x: 0, y: 770, w: 1280, h: 30, across: true },
};

export class World {
  gmail: Gmail; opentable: OpenTable; keep: Keep; messages: Messages; google: Google; deadEnd: DeadEnd;
  private current: App;
  private visited: string[] = [];
  private keys = new Map<string, string>();
  /** Every action performed, for the report. */
  acted: string[] = [];

  constructor() {
    const go = (url: string) => this.open(url);
    this.gmail = new Gmail(go); this.opentable = new OpenTable(go); this.keep = new Keep(go); this.messages = new Messages(go); this.google = new Google(go); this.deadEnd = new DeadEnd(go);
    this.current = this.google;
  }

  open(url: string, remember = true) {
    const parsed = URL.parse(url) ?? new URL("https://www.google.com/");
    const host = parsed.hostname;
    const app = host === "mail.google.com" ? this.gmail : host.endsWith("opentable.com") ? this.opentable : host === "keep.google.com" ? this.keep : host === "messages.google.com" ? this.messages
      : host.endsWith("google.com") ? this.google : this.deadEnd;
    app.focus = null;
    (app as App & { open(url: URL): void }).open(parsed);
    this.current = app;
    if (remember) this.visited.push(parsed.href);
  }

  look(): Observation {
    const page = this.current.page(), placed = new Map<Zone, number>(), total = new Map<Zone, number>();
    for (const s of page.specs) total.set(s.zone ?? "main", (total.get(s.zone ?? "main") ?? 0) + 1);
    this.keys.clear();
    const elements: (UiElement & { options?: string[] })[] = page.specs.map((s, i) => {
      const zone = s.zone ?? "main", box = ZONES[zone], n = total.get(zone)!, k = placed.get(zone) ?? 0;
      placed.set(zone, k + 1);
      const rect = box.across ? { x: Math.round(box.x + (box.w / n) * k) + 4, y: box.y + 8, w: Math.max(8, Math.round(box.w / n) - 8), h: box.h - 16 }
        : { x: box.x + 8, y: Math.round(box.y + (box.h / n) * k), w: box.w - 16, h: Math.max(8, Math.round(box.h / n) - 4) };
      const id = `e${i + 1}`;
      this.keys.set(id, s.key);
      return { id, source: "atspi", role: s.role, name: s.name, value: s.value ?? "", editable: Boolean(s.editable), focused: Boolean(s.editable) && this.current.focus === s.key, within: s.within ?? "", frame: page.title, rect, ...(s.options ? { options: s.options } : {}) };
    });
    const seen = JSON.stringify([page.url, page.title, page.specs.map((s) => [s.key, s.name, s.value]), page.texts, this.current.focus]);
    return { elements, texts: [`page: ${page.title}`, `address: ${page.url}`, ...page.texts], frames: [page.title], fingerprint: Bun.hash(seen).toString(16) };
  }

  /** The page the browser is on, as win/jev.ts reads it off the hand: for requests that carry on from it. */
  here(): { url: string; title: string } { const page = this.current.page(); return { url: page.url, title: page.title }; }

  /** The app's own stable name for an element of the last look ("send", "slot_2_0"). Evals label gold targets with it. */
  keyOf(id: string): string | undefined { return this.keys.get(id); }

  act(action: SimAction, described: string) {
    this.acted.push(described);
    const app = this.current, key = (el: UiElement) => this.keys.get(el.id);
    if (action.kind === "click") {
      const k = key(action.target);
      if (!k) return;
      if (action.target.editable) app.focus = k;
      app.click(k);
    } else if (action.kind === "type") {
      const k = action.target ? key(action.target) : app.focus;
      if (!k) return;
      if (action.target) { app.focus = k; app.click(k); }
      app.setField(k, action.text);
      if (action.submit) app.enter();
    } else if (action.kind === "select") {
      const k = key(action.target);
      if (k) app.select(k, action.option);
    } else if (action.kind === "key") {
      if (action.combo === "Return") app.enter();
      else if (action.combo === "Tab") app.tab();
      else if (action.combo === "alt+Left" && this.visited.length > 1) { this.visited.pop(); this.open(this.visited.at(-1)!, false); }
    }
  }
}
