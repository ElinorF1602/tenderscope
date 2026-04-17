import { useState, useEffect, useRef } from "react";
import supabase from "../lib/supabase";

// ─── Shared DB via Supabase (replaces window.storage) ────────────────────────
const db = {
  async get(k) {
    try {
      const { data } = await supabase
        .from("kv_store")
        .select("value")
        .eq("key", k)
        .maybeSingle();
      return data ? JSON.parse(data.value) : null;
    } catch { return null; }
  },
  async set(k, v) {
    try {
      await supabase.from("kv_store").upsert(
        { key: k, value: JSON.stringify(v), updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );
    } catch {}
  },
  async del(k) {
    try {
      await supabase.from("kv_store").delete().eq("key", k);
    } catch {}
  },
};

// ─── Sources ──────────────────────────────────────────────────────────────────
const SOURCES = [
  { id: "mr",     name: "מנהל הרכש הממשלתי", icon: "🏛️" },
  { id: "water",  name: "נציבות המים",         icon: "💧" },
  { id: "roads",  name: "נתיבי ישראל",         icon: "🛣️" },
  { id: "masham", name: "שלטון מקומי",         icon: "🏙️" },
];

// ─── GO/NO-GO Fields ──────────────────────────────────────────────────────────
const GONOGO_FIELDS = [
  { id: "client_desc",   label: "מזמין העבודה",                      hint: "שם הגוף המזמין ותחום פעילותו" },
  { id: "deadlines",     label: "לוח זמנים / DEADLINES",             hint: "כנס מציעים | שאלות הבהרה | מועד הגשה" },
  { id: "liability",     label: "אחריות",                             hint: "מוגבלת / בלתי מוגבלת" },
  { id: "guarantees",    label: "ערבויות",                            hint: "ערבות מכרז, ערבות ביצוע — גובה ותנאים" },
  { id: "insurance",     label: "ביטוחים",                            hint: "סוג, גובה ותנאי הביטוח" },
  { id: "contract_pts",  label: "קריאת החוזה — נקודות מיוחדות",     hint: "סעיף לשורה — בטיחות, אחריות, עיצומים" },
  { id: "legal_review",  label: "Legal Review מורחב?",               hint: "כן / לא" },
  { id: "risk_review",   label: "סיכונים מיוחדים",                   hint: "פרט סיכונים מרכזיים" },
  { id: "who_handles",   label: "מי יכול לטפל",                      hint: "למילוי הצוות — + האם נדרש יחס עובד-מעביד?" },
  { id: "jv",            label: "שיתוף עם צד שלישי",                 hint: "קבלנות משנה / JV — אפשרי / לא ניתן" },
  { id: "intl",          label: "התמחות בינלאומית",                  hint: "כן / לא נדרש" },
  { id: "fee_mechanism", label: "מנגנון שכ\"ט",                      hint: "שעתי / אחוז / פאושלי" },
  { id: "duration",      label: "משך ההתקשרות",                      hint: "תקופה ראשית + אופציות + תקופת ניסיון" },
  { id: "prerequisites", label: "תנאי סף",                            hint: "האם החברה עומדת בתנאים?" },
  { id: "scoring",       label: "ניקוד המכרז",                       hint: "איכות / מחיר ויחסי הניקוד" },
  { id: "location",      label: "מיקום הפרויקט",                     hint: "צפון / דרום / מרכז" },
];

const buildJsonSchema = () => {
  const fieldLines = GONOGO_FIELDS.map(f => `  "${f.id}": "עד 10 מילים — עובדה בלבד"`).join(",\n");
  return `{
  "title": "שם המכרז המלא",
  "client": "שם קצר של הגוף המזמין",
  "value": "סכום בש\"ח או לא ידוע",
  "deadline": "DD.MM.YYYY",
${fieldLines},
  "rec_decision": "go או conditional או nogo",
  "rec_score": 0,
  "rec_risk": "נמוך או בינוני או גבוה",
  "rec_summary": "משפט אחד — עד 15 מילים",
  "rec_pros": ["3-4 מילים","3-4 מילים"],
  "rec_cons": ["3-4 מילים","3-4 מילים"]
}`;
};

// ─── Claude API helpers (call /api/claude — key stays on server) ──────────────
async function callClaude(body) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function fillFormFromContent(info) {
  const data = await callClaude({
    model: "claude-sonnet-4-20250514",
    max_tokens: 10000,
    system: `אתה מנתח מכרזים. כללים נוקשים:
- כתוב רק מידע שמופיע מפורשות במסמך. אסור להסיק, לשער, או להמציא.
- אם המידע לא מופיע — כתוב "לא צוין". לא יותר.

הוראות לשדות ספציפיים:
- deadlines: רק מועדי ההגשה — כנס מציעים, שאלות הבהרה, מועד הגשה. פורמט: "כנס מציעים: DD.MM | שאלות: DD.MM | הגשה: DD.MM". לא לוח זמנים של הפרויקט.
- duration: תקופה ראשית + אופציות בלבד. דוגמה: "12 חודשים + אופציה 48 חודשים. תקופת ניסיון 6 חודשים."
- contract_pts: סעיף לשורה נפרדת. כל סעיף — 5 מילים מקסימום.
- who_handles: כתוב "למילוי הצוות" + האם המכרז דורש יחס עובד-מעביד (כן/לא).
- rec_decision: go רק אם אין מניעות ברורות. nogo אם יש דרישות שלא ניתן לעמוד בהן.
- החזר JSON בלבד, ללא markdown.`,
    messages: [{ role: "user", content: `פרטי המכרז:\n${info}\n\nמלא את השאלון הבא ב-JSON בדיוק:\n${buildJsonSchema()}` }],
  });
  const raw = (data.content || []).map(b => b.text || "").join("").trim();
  const cleaned = raw.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  return JSON.parse(cleaned);
}

async function fillFormFromUrl(url) {
  const fetchData = await callClaude({
    model: "claude-sonnet-4-20250514",
    max_tokens: 3000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    system: "גש לקישור וחלץ את כל המידע הטקסטואלי מדף המכרז. תן תשובה מפורטת ככל האפשר בעברית.",
    messages: [{ role: "user", content: `גש לדף המכרז הבא וחלץ את כל המידע: ${url}\n\nחלץ את כל הטקסט הרלוונטי: שם המכרז, גוף מזמין, ערך, מועד הגשה, תיאור, תנאי סף, ערבויות, ביטוחים, אחריות, ניקוד, מיקום, מנגנון שכ"ט, סיכונים, משך. ציין כל מידע שמצאת.` }],
  });
  const pageContent = (fetchData.content || []).filter(b => b.type === "text").map(b => b.text || "").join("\n");
  if (!pageContent || pageContent.length < 50) throw new Error("לא הצלחתי לקרוא את הדף. ייתכן שהקישור דורש התחברות.");
  return fillFormFromContent(`מקור: ${url}\n\n${pageContent}`);
}

async function fillFormFromPdf(base64Data) {
  const data = await callClaude({
    model: "claude-sonnet-4-20250514",
    max_tokens: 10000,
    system: `אתה מנתח מכרזים. כללים נוקשים:
- כתוב רק מידע שמופיע מפורשות במסמך. אסור להסיק, לשער, או להמציא.
- אם המידע לא מופיע — כתוב "לא צוין". לא יותר.
- title = שם המכרז כפי שכתוב בכותרת בלבד.

הוראות לשדות ספציפיים:
- deadlines: רק מועדי ההגשה — כנס מציעים, שאלות הבהרה, מועד הגשה. פורמט: "כנס מציעים: DD.MM | שאלות: DD.MM | הגשה: DD.MM". לא לוח זמנים של הפרויקט.
- duration: תקופה ראשית + אופציות בלבד. דוגמה: "12 חודשים + אופציה 48 חודשים. תקופת ניסיון 6 חודשים."
- contract_pts: סעיף לשורה נפרדת (\n בין סעיפים). כל סעיף — 5 מילים מקסימום.
- who_handles: כתוב "למילוי הצוות" + האם המכרז דורש יחס עובד-מעביד (כן/לא).
- החזר JSON בלבד ללא markdown.`,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
        { type: "text", text: `קרא את מסמך המכרז ומלא את השאלון:\n${buildJsonSchema()}` },
      ],
    }],
  });
  const raw = (data.content || []).map(b => b.text || "").join("").trim();
  const cleaned = raw.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  return JSON.parse(cleaned);
}

// ─── Decision map ─────────────────────────────────────────────────────────────
const DM = {
  go:          { color: "#34d399", bg: "rgba(52,211,153,0.12)",  border: "rgba(52,211,153,0.35)",  label: "GO",         emoji: "✅" },
  conditional: { color: "#fbbf24", bg: "rgba(251,191,36,0.12)",  border: "rgba(251,191,36,0.35)",  label: "GO מותנה",   emoji: "🟡" },
  nogo:        { color: "#f87171", bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.35)", label: "NO-GO",      emoji: "❌" },
  irrelevant:  { color: "#64748b", bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.30)", label: "לא רלוונטי", emoji: "🚫" },
};

const parseDeadline = (str) => {
  if (!str || str === "לא ידוע" || str === "לא צוין") return null;
  let m = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  m = str.match(/(?:^|[^\d])(\d{1,2})[.\/\-](20?)(\d{2})(?:[^\d]|$)/);
  if (m) {
    const month = parseInt(m[1]);
    const year = parseInt("20" + m[3].padStart(2, "0"));
    if (month >= 1 && month <= 12) return new Date(year, month - 1, 1);
  }
  return null;
};

const isTenderActive = (t) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dl = getTenderDeadline(t);
  const title = getTenderTitle(t);
  const d = parseDeadline(dl + " " + title);
  if (d) return d >= today;
  return true;
};

const getTenderTitle    = (t) => t.form?.title    || "מכרז ללא שם";
const getTenderValue    = (t) => t.form?.value    || t.value    || "—";
const getTenderDeadline = (t) => t.form?.deadline || t.deadline || "—";

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tenders,        setTenders]        = useState([]);
  const [selected,       setSelected]       = useState(null);
  const [scanning,       setScanning]       = useState(false);
  const [scanMsg,        setScanMsg]        = useState("");
  const [lastScan,       setLastScan]       = useState(null);
  const [sitesWithTenders, setSitesWithTenders] = useState(new Set());
  const [activeFilters,  setActiveFilters]  = useState(new Set(["all"]));
  const [confirmDeleteId,setConfirmDeleteId]= useState(null);
  const [urlInput,       setUrlInput]       = useState("");
  const [urlLoading,     setUrlLoading]     = useState(false);
  const [urlError,       setUrlError]       = useState("");
  const [confirmClear,   setConfirmClear]   = useState(false);
  const [pdfLoading,     setPdfLoading]     = useState(false);
  const [pdfError,       setPdfError]       = useState("");
  const [logoSrc,        setLogoSrc]        = useState("");
  const pdfRef      = useRef(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    (async () => {
      const storedLogo = await db.get("pb_logo");
      if (storedLogo) setLogoSrc(storedLogo);
      const saved = await db.get("tenders");
      const ls    = await db.get("lastScan");
      const savedSites = await db.get("sitesWithTenders");
      if (savedSites) setSitesWithTenders(new Set(savedSites));
      if (saved?.length) { setTenders(saved); setLastScan(ls); }
      const today = new Date().toDateString();
      if (!ls || new Date(ls).toDateString() !== today) await scan(saved || []);
    })();
  }, []);

  const scan = async (existing = tenders) => {
    setScanning(true);
    setScanMsg("🔍 מחפש מכרזי ניהול ופיקוח...");

    let foundTenders = [];
    try {
      const searchData = await callClaude({
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: "אתה עוזר שמחפש מכרזי ניהול ופיקוח פרויקטים בישראל. השתמש בחיפוש Google כדי למצוא מכרזים רלוונטיים פתוחים. חפש ישירות ב-Google ולא רק באתרים עצמם — חלק מהאתרים טוענים תוכן דינמי. החזר JSON בלבד.",
        messages: [{
          role: "user",
          content: `היום: ${new Date().toLocaleDateString("he-IL")}. חפש ב-Google מכרזים פתוחים לניהול ופיקוח / ניהול ותכנון פרויקטי בנייה ותשתיות בישראל.

חפש בגוגל בעברית: "מכרז ניהול פיקוח בנייה" OR "מכרז פיקוח עליון" OR "מכרז מנהל בנייה" OR "מכרז בקרת חשבונות" site:muni.il OR site:gov.il OR site:co.il

כמו כן חפש ישירות באתרים אלו:
mr.gov.il, hameshakem.co.il, masham.org.il, tel-aviv.gov.il, jerusalem.muni.il, haifa.muni.il, beersheba.muni.il, rishonlezion.muni.il, petah-tikva.muni.il, ashdod.muni.il, netanya.muni.il, holon.muni.il, bnei-brak.muni.il, rail.co.il, natey.co.il, neta.co.il, mashcal.co.il/our-tenders/, npa.gov.il, iaa.gov.il, ports.co.il, netivei-israel.co.il, mot.gov.il, iec.co.il, mekorot.co.il, nta.co.il, moch.gov.il, economy.gov.il, raanana.muni.il, herzliya.muni.il, rehovot.muni.il, modiin.muni.il, hagihon.co.il, tashtit.co.il, ramat-hasharon.muni.il/all-tenders/, tiberias.muni.il/council_services/toshav/bids/

תחומים: ניהול פרויקט, פיקוח עליון, פיקוח צמוד, מפקח בנייה, מנהל בנייה, ניהול תכנון, ניהול ופיקוח, בקרת חשבונות קבלניים, בקרת חשבונות מתכננים, תכנון בינלאומי, ייעוץ הנדסי בינלאומי.

כלול רק מכרזים פתוחים עם מועד הגשה עתידי. אל תכלול מכרזים שנסגרו.
אם אתר לא נגיש — חפש את המכרזים שלו ב-Google במקום.

החזר JSON בלבד (ללא markdown):
{"tenders":[{"title":"שם","source":"אתר","url":"קישור מלא לדף המכרז","deadline":"DD.MM.YYYY או לא ידוע","value":"ערך או לא ידוע"}]}
מצא עד 8 מכרזים פתוחים.`,
        }],
      });

      const textBlocks = (searchData.content || []).filter(b => b.type === "text").map(b => b.text || "").join("");
      const cleaned = textBlocks.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const jsonStart = cleaned.indexOf("{");
      const jsonEnd   = cleaned.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
        foundTenders = parsed.tenders || [];
      }
      // Track which sites had tenders found
      const sitesFound = new Set();
      foundTenders.forEach(t => {
        if (t.source) sitesFound.add(t.source.toLowerCase().trim());
        if (t.url) {
          try { sitesFound.add(new URL(t.url).hostname.toLowerCase().replace(/^www\./, "")); } catch {}
        }
      });
      setSitesWithTenders(sitesFound);
      await db.set("sitesWithTenders", [...sitesFound]);
    } catch (e) {
      setScanMsg("⚠️ שגיאה בחיפוש: " + e.message);
      setScanning(false);
      return;
    }

    if (foundTenders.length === 0) {
      setScanMsg("✅ לא נמצאו מכרזים חדשים רלוונטיים");
      setActiveFilters(new Set(["pending", "go", "conditional"]));
      setScanning(false);
      return;
    }

    const existingUrls   = new Set(existing.map(t => t.url).filter(Boolean));
    const existingTitles = new Set(existing.map(t => getTenderTitle(t)));
    const todayMs = new Date().setHours(0, 0, 0, 0);
    const newTenders = foundTenders.filter(t => {
      if (!t.url) return false;
      if (existingUrls.has(t.url) || existingTitles.has(t.title)) return false;
      const d = parseDeadline(t.deadline);
      if (d && d.getTime() < todayMs) return false;
      return true;
    });

    if (newTenders.length === 0) {
      setScanMsg("✅ אין מכרזים חדשים — כולם כבר במערכת");
      setActiveFilters(new Set(["pending", "go", "conditional"]));
      setScanning(false);
      return;
    }

    const toAdd = [];
    for (let i = 0; i < newTenders.length; i++) {
      const raw = newTenders[i];
      setScanMsg(`📋 ממלא שאלון (${i + 1}/${newTenders.length}): ${raw.title.slice(0, 30)}...`);
      let form = null;
      try {
        form = await fillFormFromUrl(raw.url);
        if (!form.title || form.title.length < 3) form.title = raw.title;
        if (!form.value   || form.value   === "לא צוין") form.value   = raw.value   || "לא ידוע";
        if (!form.deadline|| form.deadline=== "לא צוין") form.deadline= raw.deadline|| "לא ידוע";
      } catch {
        form = { title: raw.title, client: raw.source, value: raw.value || "לא ידוע", deadline: raw.deadline || "לא ידוע" };
        GONOGO_FIELDS.forEach(f => { form[f.id] = "לא צוין"; });
      }
      toAdd.push({
        id: "s_" + Date.now().toString(36) + "_" + i,
        source: "scan",
        sourceName: raw.source,
        url: raw.url,
        form,
        yariv: null,
        scannedAt: new Date().toISOString(),
      });
    }

    const updated = [...toAdd, ...existing];
    const now = new Date().toISOString();
    setTenders(updated); setLastScan(now);
    await db.set("tenders", updated); await db.set("lastScan", now);
    setScanMsg(`✅ נמצאו ${toAdd.length} מכרזים חדשים`);
    setActiveFilters(new Set(["pending", "go", "conditional"]));
    setScanning(false);
  };

  const handleUrlSubmit = async () => {
    const url = urlInput.trim();
    if (!url) return;
    if (!url.startsWith("http")) { setUrlError("נא להזין URL תקין (מתחיל ב-http)"); return; }
    setUrlLoading(true); setUrlError("");
    try {
      const form = await fillFormFromUrl(url);
      const id = "u_" + btoa(encodeURIComponent(url)).slice(0, 12);
      const newTender = { id, source: "manual", url, form, yariv: null, scannedAt: new Date().toISOString(), isManual: true };
      const updated = [newTender, ...tenders];
      setTenders(updated); await db.set("tenders", updated);
      setSelected(newTender); setUrlInput("");
    } catch (e) { setUrlError(e.message || "שגיאה בניתוח הקישור."); }
    setUrlLoading(false);
  };

  const handlePdfUpload = async (e) => {
    const files = Array.from(e.target.files || []).filter(f => f.name.toLowerCase().endsWith(".pdf"));
    if (!files.length) return;
    setPdfLoading(true); setPdfError("");
    try {
      const pdfContents = await Promise.all(files.map(f => new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res({ name: f.name, data: r.result.split(",")[1] });
        r.onerror = () => rej(new Error("שגיאה בקריאת " + f.name));
        r.readAsDataURL(f);
      })));
      const msgContent = [
        ...pdfContents.map(p => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.data } })),
        { type: "text", text: `קרא את כל המסמכים ומלא את השאלון. שים לב: שדה "title" חייב להיות שם המכרז כפי שמופיע במסמך, לא שם הקובץ:\n${buildJsonSchema()}` },
      ];
      const data = await callClaude({
        model: "claude-sonnet-4-20250514", max_tokens: 10000,
        system: `אתה מנתח מכרזים. כללים נוקשים:
- כתוב רק מידע שמופיע מפורשות במסמך. אסור להסיק, לשער, או להמציא.
- אם המידע לא מופיע — כתוב "לא צוין". לא יותר.
- title = שם המכרז כפי שכתוב בכותרת בלבד.

הוראות לשדות ספציפיים:
- deadlines: רק מועדי ההגשה. פורמט: "כנס מציעים: DD.MM | שאלות: DD.MM | הגשה: DD.MM".
- duration: תקופה ראשית + אופציות בלבד.
- contract_pts: סעיף לשורה נפרדת. כל סעיף — 5 מילים מקסימום.
- who_handles: כתוב "למילוי הצוות" + יחס עובד-מעביד כן/לא.
- החזר JSON בלבד ללא markdown.`,
        messages: [{ role: "user", content: msgContent }],
      });
      if (data.error) throw new Error("API: " + (data.error.message || JSON.stringify(data.error)));
      const raw = (data.content || []).map(b => b.text || "").join("").trim()
        .replace(/```json/g, "").replace(/```/g, "").trim();
      if (!raw) throw new Error("התגובה ריקה");
      const jsonStart = raw.indexOf("{"); const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart === -1) throw new Error("לא נמצא JSON: " + raw.slice(0, 120));
      const form = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      if (!form.title || form.title.length < 3) throw new Error("לא זוהה שם מכרז במסמך");
      const id = "p_" + Date.now().toString(36);
      const newTender = { id, source: "manual", docs: files.map(f => f.name), form, yariv: null, scannedAt: new Date().toISOString(), isManual: true, isPdf: true };
      const updated = [newTender, ...tenders];
      setTenders(updated); await db.set("tenders", updated);
      setSelected(newTender);
      if (pdfRef.current) pdfRef.current.value = "";
    } catch (err) { setPdfError(err.message || "שגיאה בניתוח ה-PDF"); }
    setPdfLoading(false);
  };

  const saveTenderField = async (tenderId, fields) => {
    const updated = tenders.map(t => t.id === tenderId ? { ...t, ...fields } : t);
    setTenders(updated); await db.set("tenders", updated);
    if (selected?.id === tenderId) setSelected(prev => ({ ...prev, ...fields }));
  };

  const saveYariv = async (tenderId, data) => {
    if (data.type === "team") {
      await saveTenderField(tenderId, { teamNotes: data.teamNotes });
    } else {
      await saveTenderField(tenderId, { yariv: { decision: data.decision, notes: data.notes, savedAt: data.savedAt } });
    }
  };

  const addDocsToTender = async (tenderId, newForm, docNames) => {
    const updated = tenders.map(t =>
      t.id === tenderId ? { ...t, form: newForm, docs: [...(t.docs || []), ...docNames] } : t
    );
    setTenders(updated); await db.set("tenders", updated);
    if (selected?.id === tenderId) setSelected(prev => ({ ...prev, form: newForm, docs: [...(prev.docs || []), ...docNames] }));
  };

  const clearAll = async () => {
    await db.del("tenders"); await db.del("lastScan"); await db.del("tenders_v2");
    setTenders([]); setSelected(null); setLastScan(null);
    setScanMsg("🗑 כל המכרזים נמחקו"); setConfirmClear(false);
  };

  const deleteTender = async (id) => {
    const updated = tenders.filter(t => t.id !== id);
    setTenders(updated); await db.set("tenders", updated);
    if (selected?.id === id) setSelected(null);
    setConfirmDeleteId(null);
  };

  const toggleFilter = (val) => {
    if (val === "all") { setActiveFilters(new Set(["all"])); return; }
    setActiveFilters(prev => {
      const next = new Set(prev); next.delete("all");
      if (next.has(val)) { next.delete(val); if (next.size === 0) next.add("all"); }
      else next.add(val);
      return next;
    });
  };

  const active   = tenders.filter(isTenderActive);
  const filtered = active.filter(t => {
    if (activeFilters.has("all")) return true;
    if (activeFilters.has("pending") && !t.yariv?.decision) return true;
    if (t.yariv?.decision && activeFilters.has(t.yariv.decision)) return true;
    return false;
  });
  const counts = {
    all:         active.length,
    pending:     active.filter(t => !t.yariv?.decision).length,
    go:          active.filter(t => t.yariv?.decision === "go").length,
    conditional: active.filter(t => t.yariv?.decision === "conditional").length,
    nogo:        active.filter(t => t.yariv?.decision === "nogo").length,
    irrelevant:  active.filter(t => t.yariv?.decision === "irrelevant").length,
  };
  const lastScanStr = lastScan
    ? new Date(lastScan).toLocaleString("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f8f9fb", color: "#1e293b", fontFamily: "'Heebo','Assistant',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700;800;900&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#f8f9fb}::-webkit-scrollbar-thumb{background:#fca5a5;border-radius:3px}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        .card{transition:all 0.18s;cursor:pointer}
        .card:hover{background:#fef2f2!important;border-color:rgba(56,189,248,0.4)!important}
        .card.sel{background:#fef2f2!important;border-color:rgba(56,189,248,0.55)!important;box-shadow:0 0 0 1px rgba(56,189,248,0.15)}
        .btn{transition:all 0.15s;cursor:pointer;border:none;font-family:inherit}
        .btn:hover{filter:brightness(1.1)}.btn:active{transform:scale(0.97)}
        .chip{transition:all 0.15s;cursor:pointer}
        .fu{animation:fadeUp 0.28s ease}
        .frow:nth-child(odd){background:rgba(255,255,255,0.015)}
      `}</style>

      {/* HEADER */}
      <header style={{ background: "#ffffff", borderBottom: "1px solid rgba(220,38,38,0.12)", padding: "0 24px", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", alignItems: "center", gap: 14, padding: "12px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {logoSrc
              ? <img src={logoSrc} style={{ width: 80, height: 80, objectFit: "contain" }} alt="logo" />
              : <label title="לחץ להעלאת לוגו" style={{ width: 80, height: 80, display: "flex", alignItems: "center", justifyContent: "center", background: "#fee2e2", borderRadius: 8, cursor: "pointer", fontSize: 11, color: "#dc2626", textAlign: "center", padding: 4, flexDirection: "column", gap: 2 }}>
                  <span style={{ fontWeight: 900, fontSize: 16 }}>PB</span>
                  <span>ISRAEL</span>
                  <input type="file" accept="image/*" style={{ display: "none" }} onChange={async e => {
                    const file = e.target.files[0]; if (!file) return;
                    const reader = new FileReader();
                    reader.onload = async ev => { const data = ev.target.result; setLogoSrc(data); await db.set("pb_logo", data); };
                    reader.readAsDataURL(file);
                  }} />
                </label>
            }
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 900, letterSpacing: "-0.2px", lineHeight: 1.2 }}>מכרזי חטיבת בינוי PB ISRAEL</div>
              <div style={{ fontSize: 10, color: "#64748b" }}>שאלון GO/NO-GO אוטומטי · החלטת הצוות</div>
            </div>
          </div>
          <div style={{ marginRight: "auto", fontSize: 11.5, display: "flex", alignItems: "center", gap: 7, color: scanning ? "#38bdf8" : scanMsg.startsWith("✅") ? "#34d399" : "#475569" }}>
            {scanning && <div style={{ width: 12, height: 12, border: "2px solid rgba(220,38,38,0.2)", borderTop: "2px solid #dc2626", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />}
            {scanMsg || (lastScanStr ? `סריקה אחרונה: ${lastScanStr}` : "")}
          </div>
          <button className="btn" onClick={() => scan()} disabled={scanning}
            style={{ padding: "8px 15px", borderRadius: 8, background: scanning ? "rgba(56,189,248,0.08)" : "linear-gradient(135deg,#1e40af,#0369a1)", color: scanning ? "#475569" : "white", fontWeight: 800, fontSize: 12, display: "flex", alignItems: "center", gap: 7 }}>
            {scanning ? <><div style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.2)", borderTop: "2px solid white", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />סורק...</> : "🔍 סרוק מכרזים"}
          </button>
          <button className="btn" onClick={() => {
            const win = window.open("", "_blank");
            const rows = active.map(t => {
              const dm = t.yariv?.decision ? DM[t.yariv.decision] : null;
              const dec = dm ? `<span style="color:${dm.color};font-weight:800">${dm.emoji} ${dm.label}</span>` : '<span style="color:#94a3b8">ממתין</span>';
              return `<tr style="border-bottom:1px solid #f1f5f9"><td style="padding:8px 10px;font-size:12px;font-weight:700">${getTenderTitle(t)}</td><td style="padding:8px 10px;font-size:11px;color:#64748b">${t.form?.client || "—"}</td><td style="padding:8px 10px;font-size:11px;color:#dc2626;font-weight:700">${getTenderValue(t)}</td><td style="padding:8px 10px;font-size:11px">${getTenderDeadline(t)}</td><td style="padding:8px 10px">${dec}</td><td style="padding:8px 10px;font-size:10px;color:#94a3b8">${t.yariv?.notes || ""}</td></tr>`;
            }).join("");
            const c = { go: active.filter(t => t.yariv?.decision === "go").length, conditional: active.filter(t => t.yariv?.decision === "conditional").length, nogo: active.filter(t => t.yariv?.decision === "nogo").length, pending: active.filter(t => !t.yariv?.decision).length };
            win.document.write(`<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>רשימת מכרזים PB ISRAEL</title><link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;900&display=swap" rel="stylesheet"><style>body{font-family:'Heebo',sans-serif;padding:32px;color:#1e293b}table{width:100%;border-collapse:collapse}th{background:#dc2626;color:white;padding:9px 10px;text-align:right;font-size:11px}@media print{body{padding:16px}}</style></head><body><div style="border-bottom:3px solid #dc2626;padding-bottom:12px;margin-bottom:20px"><div style="font-size:22px;font-weight:900">סיכום מכרזים פעילים</div><div style="font-size:11px;color:#64748b">הופק: ${new Date().toLocaleString("he-IL")}</div></div><div style="display:flex;gap:20px;margin-bottom:20px"><div style="background:#f0fdf4;border:1px solid #34d399;border-radius:8px;padding:10px 16px;text-align:center"><div style="font-size:20px;font-weight:900;color:#34d399">${c.go}</div><div style="font-size:10px">GO</div></div><div style="background:rgba(251,191,36,0.1);border:1px solid #fbbf24;border-radius:8px;padding:10px 16px;text-align:center"><div style="font-size:20px;font-weight:900;color:#fbbf24">${c.conditional}</div><div style="font-size:10px">מותנה</div></div><div style="background:rgba(248,113,113,0.1);border:1px solid #f87171;border-radius:8px;padding:10px 16px;text-align:center"><div style="font-size:20px;font-weight:900;color:#f87171">${c.nogo}</div><div style="font-size:10px">NO-GO</div></div><div style="background:#f8f9fb;border:1px solid #cbd5e1;border-radius:8px;padding:10px 16px;text-align:center"><div style="font-size:20px;font-weight:900;color:#64748b">${c.pending}</div><div style="font-size:10px">ממתין</div></div></div><table><thead><tr><th>שם המכרז</th><th>מזמין</th><th>ערך</th><th>הגשה</th><th>החלטה</th><th>הערות</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>{window.print();}<\/script></body></html>`);
            win.document.close();
          }} style={{ padding: "8px 12px", borderRadius: 8, background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.2)", color: "#dc2626", fontWeight: 800, fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>📋 ייצא רשימה</button>
        </div>
      </header>

      {/* SITES BAR */}
      <div style={{ background: "#f1f5f9", borderBottom: "1px solid rgba(220,38,38,0.08)", padding: "6px 24px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: "#64748b", flexShrink: 0 }}>🔍 אתרים שנסרקים:</span>
          {["mr.gov.il","hameshakem.co.il","masham.org.il","tel-aviv.gov.il","jerusalem.muni.il","haifa.muni.il","beersheba.muni.il","rishonlezion.muni.il","petah-tikva.muni.il","ashdod.muni.il","netanya.muni.il","holon.muni.il","bnei-brak.muni.il","rail.co.il","natey.co.il","neta.co.il","mashcal.co.il","npa.gov.il","iaa.gov.il","ports.co.il","netivei-israel.co.il","mot.gov.il","iec.co.il","mekorot.co.il","nta.co.il","moch.gov.il","economy.gov.il","raanana.muni.il","herzliya.muni.il","rehovot.muni.il","modiin.muni.il","hagihon.co.il","tashtit.co.il","ramat-hasharon.muni.il","tiberias.muni.il"].map(site => {
            const hasTenders = [...sitesWithTenders].some(s => s.includes(site) || site.includes(s));
            const wasScanned = !!lastScan;
            return (
              <span key={site} title={hasTenders ? "נמצאו מכרזים באתר זה" : wasScanned ? "נסרק — לא נמצאו מכרזים" : "טרם נסרק"} style={{
                fontSize: 9.5,
                background: hasTenders ? "rgba(52,211,153,0.1)" : wasScanned ? "rgba(56,189,248,0.05)" : "white",
                border: `1px solid ${hasTenders ? "rgba(52,211,153,0.45)" : wasScanned ? "rgba(56,189,248,0.2)" : "rgba(220,38,38,0.15)"}`,
                borderRadius: 4,
                padding: "2px 6px 2px 5px",
                color: hasTenders ? "#16a34a" : wasScanned ? "#64748b" : "#475569",
                fontFamily: "monospace",
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
              }}>
                {site}
                {hasTenders && <span style={{ color: "#16a34a", fontSize: 9, fontWeight: 900, fontFamily: "sans-serif" }}>✓</span>}
                {!hasTenders && wasScanned && <span style={{ color: "#94a3b8", fontSize: 9, fontFamily: "sans-serif" }}>✓</span>}
              </span>
            );
          })}
          {lastScan && (
            <span style={{ fontSize: 9, color: "#94a3b8", marginRight: "auto", whiteSpace: "nowrap" }}>
              <span style={{ color: "#16a34a" }}>✓</span> מכרזים נמצאו  
              <span style={{ color: "#94a3b8" }}>✓</span> נסרק, אין מכרזים
            </span>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "18px 24px", display: "grid", gridTemplateColumns: selected ? "1fr 510px" : "1fr", gap: 16, alignItems: "start" }}>
        <div>
          {/* Input bar */}
          <div style={{ background: "#ffffff", border: "1px solid rgba(220,38,38,0.15)", borderRadius: 12, padding: "13px 15px", marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 10 }}>הוסף מכרז — הדבק קישור או העלה PDF של חוברת המכרז</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input value={urlInput} onChange={e => { setUrlInput(e.target.value); setUrlError(""); }}
                onKeyDown={e => e.key === "Enter" && !urlLoading && handleUrlSubmit()}
                placeholder="🔗 העתק קישור למכרז והדבק כאן" disabled={urlLoading || pdfLoading}
                style={{ flex: 1, padding: "9px 12px", borderRadius: 8, border: `1px solid ${urlError ? "rgba(248,113,113,0.5)" : "rgba(56,189,248,0.15)"}`, background: "#f1f5f9", color: "#1e293b", fontSize: 12.5, fontFamily: "inherit", outline: "none" }} />
              <button className="btn" onClick={handleUrlSubmit} disabled={urlLoading || pdfLoading || !urlInput.trim()}
                style={{ padding: "9px 15px", borderRadius: 8, background: urlLoading || pdfLoading || !urlInput.trim() ? "rgba(56,189,248,0.06)" : "linear-gradient(135deg,#1e40af,#0369a1)", color: urlLoading || pdfLoading || !urlInput.trim() ? "#334155" : "white", fontWeight: 800, fontSize: 12, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
                {urlLoading ? <><div style={{ width: 11, height: 11, border: "2px solid rgba(255,255,255,0.2)", borderTop: "2px solid white", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />מנתח...</> : "נתח קישור"}
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(220,38,38,0.12)", background: "#f1f5f9", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                onClick={() => !pdfLoading && !urlLoading && pdfRef.current?.click()}>
                <span style={{ fontSize: 16 }}>📄</span>
                <span style={{ fontSize: 12, color: pdfLoading ? "#38bdf8" : "#475569" }}>{pdfLoading ? "קורא את ה-PDF וממלא שאלון..." : "העלה PDF של חוברת המכרז"}</span>
                {pdfLoading && <div style={{ width: 12, height: 12, border: "2px solid rgba(220,38,38,0.2)", borderTop: "2px solid #dc2626", borderRadius: "50%", animation: "spin 0.8s linear infinite", marginRight: "auto" }} />}
              </div>
              <input ref={pdfRef} type="file" accept=".pdf" style={{ display: "none" }} onChange={handlePdfUpload} />
            </div>
            {(urlError || pdfError) && <div style={{ fontSize: 11, color: "#f87171", marginTop: 7 }}>{urlError || pdfError}</div>}
          </div>

          {/* KPIs */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 8, marginBottom: 14 }}>
            {[["סה\"כ", counts.all, "#38bdf8"], ["⏳ ממתין", counts.pending, "#64748b"], ["✅ GO", counts.go, "#34d399"], ["🟡 מותנה", counts.conditional, "#fbbf24"], ["❌ NO-GO", counts.nogo, "#f87171"], ["🚫 לא רלוונטי", counts.irrelevant, "#64748b"]].map(([l, v, c]) => (
              <div key={l} style={{ background: "#ffffff", border: "1.5px solid rgba(0,0,0,0.13)", borderRadius: 10, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600, marginBottom: 3 }}>{l}</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: c }}>{v}</div>
              </div>
            ))}
          </div>

          {/* Filters */}
          <div style={{ display: "flex", gap: 6, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
            {[["all", "הכל"], ["pending", "ממתין"], ["go", "GO"], ["conditional", "מותנה"], ["nogo", "NO-GO"], ["irrelevant", "לא רלוונטי"]].map(([val, lbl]) => {
              const isActive = activeFilters.has(val);
              return (
                <div key={val} className="chip" onClick={() => toggleFilter(val)}
                  style={{ padding: "4px 12px", borderRadius: 14, fontSize: 11.5, fontWeight: 700, userSelect: "none", background: isActive ? "rgba(56,189,248,0.15)" : "transparent", border: `1px solid ${isActive ? "rgba(220,38,38,0.5)" : "rgba(56,189,248,0.1)"}`, color: isActive ? "#38bdf8" : "#475569", display: "flex", alignItems: "center", gap: 4 }}>
                  {isActive && val !== "all" && <span style={{ fontSize: 9, opacity: 0.7 }}>✓</span>}
                  {lbl}
                </div>
              );
            })}
            {!confirmClear
              ? <button className="btn" onClick={() => setConfirmClear(true)} style={{ marginRight: "auto", background: "none", color: "#94a3b8", fontSize: 10.5, padding: "4px 8px" }}>🗑 נקה הכל</button>
              : <div style={{ marginRight: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 10.5, color: "#dc2626", fontWeight: 700 }}>למחוק הכל?</span>
                  <button className="btn" onClick={clearAll} style={{ padding: "3px 10px", borderRadius: 6, background: "#dc2626", color: "white", fontSize: 10.5, fontWeight: 700 }}>כן</button>
                  <button className="btn" onClick={() => setConfirmClear(false)} style={{ padding: "3px 10px", borderRadius: 6, background: "rgba(0,0,0,0.06)", color: "#64748b", fontSize: 10.5 }}>ביטול</button>
                </div>
            }
          </div>

          {/* Cards */}
          {scanning && tenders.length === 0 ? (
            <div style={{ textAlign: "center", padding: "70px 0" }}>
              <div style={{ width: 42, height: 42, border: "3px solid rgba(220,38,38,0.15)", borderTop: "3px solid #dc2626", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 14px" }} />
              <div style={{ fontSize: 13, color: "#64748b" }}>מחפש מכרזים וממלא שאלונים...</div>
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 0" }}>
              <div style={{ fontSize: 34, marginBottom: 8 }}>📭</div>
              <div style={{ fontSize: 13, color: "#64748b" }}>אין מכרזים {!activeFilters.has("all") ? "בקטגוריה זו" : ""}</div>
            </div>
          ) : (
            <div className="fu" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {filtered.map(t => {
                const src  = SOURCES.find(s => s.id === t.source);
                const dm   = t.yariv?.decision ? DM[t.yariv.decision] : null;
                const isSel = selected?.id === t.id;
                return (
                  <div key={t.id} className={`card${isSel ? " sel" : ""}`} onClick={() => setSelected(isSel ? null : t)}
                    style={{ background: "#ffffff", border: `1.5px solid ${t.isManual ? "rgba(168,85,247,0.45)" : "rgba(56,189,248,0.3)"}`, borderRadius: 11, padding: "13px 15px" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                      <span style={{ fontSize: 17, flexShrink: 0, marginTop: 2 }}>{t.isPdf ? "📄" : t.isManual ? "🔗" : t.source === "scan" ? "🔍" : src?.icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 10, color: t.isPdf ? "#f59e0b" : t.isManual ? "#a855f7" : t.source === "scan" ? "#34d399" : "#475569", fontWeight: 600 }}>
                            {t.isPdf ? `📄 ${t.docs?.length || 1} קבצים` : t.isManual ? "🔗 קישור ידני" : t.source === "scan" ? (t.sourceName || "סריקה אוטומטית") : src?.name}
                          </span>
                          <span style={{ color: "#cbd5e1", fontSize: 10 }}>·</span>
                          <span style={{ fontSize: 10, color: "#64748b" }}>הגשה: {getTenderDeadline(t)}</span>
                          <span style={{ fontSize: 11, color: "#dc2626", fontWeight: 700, marginRight: "auto" }}>{getTenderValue(t)}</span>
                        </div>
                        <div style={{ fontSize: 13.5, fontWeight: 800, lineHeight: 1.35, marginBottom: 7, color: "#1e293b" }}>{getTenderTitle(t)}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          {dm
                            ? <span style={{ padding: "2px 10px", borderRadius: 8, fontSize: 11, fontWeight: 800, background: dm.bg, color: dm.color, border: `1px solid ${dm.border}` }}>{dm.emoji} {dm.label}</span>
                            : <span style={{ padding: "2px 10px", borderRadius: 8, fontSize: 10.5, fontWeight: 600, background: "rgba(100,116,139,0.1)", color: "#64748b", border: "1px solid rgba(100,116,139,0.15)" }}>⏳ ממתין להחלטה</span>
                          }
                          {t.form?.rec_decision && !dm && (
                            <span style={{ fontSize: 10.5, color: "#94a3b8" }}>המלצה: {DM[t.form.rec_decision]?.emoji} {DM[t.form.rec_decision]?.label}</span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flexShrink: 0, marginTop: 2 }}>
                        <span style={{ fontSize: 11, color: "#cbd5e1" }}>{isSel ? "▲" : "▼"}</span>
                        {confirmDeleteId === t.id ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 3 }} onClick={e => e.stopPropagation()}>
                            <button className="btn" onClick={() => deleteTender(t.id)} style={{ padding: "2px 7px", borderRadius: 5, background: "#dc2626", color: "white", fontSize: 9.5, fontWeight: 700 }}>מחק</button>
                            <button className="btn" onClick={() => setConfirmDeleteId(null)} style={{ padding: "2px 7px", borderRadius: 5, background: "rgba(0,0,0,0.06)", color: "#64748b", fontSize: 9.5 }}>ביטול</button>
                          </div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }} onClick={e => e.stopPropagation()}>
                            <button className="btn" onClick={e => { e.stopPropagation(); saveTenderField(t.id, { yariv: { decision: t.yariv?.decision === "irrelevant" ? null : "irrelevant", notes: "", savedAt: new Date().toISOString() } }); }}
                              style={{ background: t.yariv?.decision === "irrelevant" ? "rgba(148,163,184,0.2)" : "none", color: t.yariv?.decision === "irrelevant" ? "#64748b" : "#cbd5e1", fontSize: 11, padding: "2px 4px", borderRadius: 5, border: t.yariv?.decision === "irrelevant" ? "1px solid rgba(148,163,184,0.4)" : "none", lineHeight: 1 }} title="סמן כלא רלוונטי">🚫</button>
                            <button className="btn" onClick={e => { e.stopPropagation(); setConfirmDeleteId(t.id); }}
                              style={{ background: "none", color: "#cbd5e1", fontSize: 13, padding: "1px 3px", lineHeight: 1 }} title="מחק מכרז">🗑</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {selected && <DetailPanel key={selected.id} tender={selected} onClose={() => setSelected(null)} onSaveYariv={saveYariv} onAddDocs={addDocsToTender} />}
      </div>
    </div>
  );
}

// ─── Detail Panel ─────────────────────────────────────────────────────────────
function DetailPanel({ tender: t, onClose, onSaveYariv, onAddDocs }) {
  const src = SOURCES.find(s => s.id === t.source);
  const [decision,    setDecision]   = useState(t.yariv?.decision || "");
  const [yarivNotes,  setYarivNotes] = useState(t.yariv?.notes    || "");
  const [teamNotes,   setTeamNotes]  = useState(t.teamNotes       || "");
  const [yarivSaved,  setYarivSaved] = useState(false);
  const [teamSaved,   setTeamSaved]  = useState(false);
  const [docLoading,  setDocLoading] = useState(false);
  const [urlLoading,  setUrlLoading] = useState(false);
  const [docUrl,      setDocUrl]     = useState("");
  const [docError,    setDocError]   = useState("");
  const [editMode,    setEditMode]   = useState(false);
  const [editForm,    setEditForm]   = useState({});
  const filesRef = useRef(null);

  const startEdit = () => { setEditForm({ ...t.form }); setEditMode(true); };
  const saveEdit  = () => { onAddDocs(t.id, editForm, []); setEditMode(false); };

  const saveYarivDecision = () => {
    if (!decision) return;
    onSaveYariv(t.id, { type: "yariv", decision, notes: yarivNotes, savedAt: new Date().toISOString() });
    setYarivSaved(true); setTimeout(() => setYarivSaved(false), 2000);
  };
  const saveTeam = () => {
    onSaveYariv(t.id, { type: "team", teamNotes });
    setTeamSaved(true); setTimeout(() => setTeamSaved(false), 2000);
  };

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files || []).filter(f => f.name.toLowerCase().endsWith(".pdf"));
    if (!files.length) { setDocError("נא לבחור קבצי PDF"); return; }
    setDocLoading(true); setDocError("");
    try {
      const pdfContents = await Promise.all(files.map(f => new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res({ name: f.name, data: r.result.split(",")[1] }); r.onerror = () => rej(new Error("שגיאה בקריאת " + f.name)); r.readAsDataURL(f);
      })));
      const msgContent = [
        ...pdfContents.map(p => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.data } })),
        { type: "text", text: `קרא את כל המסמכים ומלא את השאלון:\n${buildJsonSchema()}` },
      ];
      const data = await callClaude({ model: "claude-sonnet-4-20250514", max_tokens: 10000, system: "אתה מנתח מכרזים. כתוב רק מה שמופיע מפורשות. אסור להמציא. JSON בלבד.", messages: [{ role: "user", content: msgContent }] });
      if (data.error) throw new Error("API: " + (data.error.message || JSON.stringify(data.error)));
      const raw = (data.content || []).map(b => b.text || "").join("").trim().replace(/```json/g, "").replace(/```/g, "").trim();
      if (!raw) throw new Error("התגובה ריקה — ייתכן שה-PDF גדול מדי או מוצפן");
      const form = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      if (!form.title || form.title.length < 3) form.title = getTenderTitle(t);
      onAddDocs(t.id, form, files.map(f => f.name));
      if (filesRef.current) filesRef.current.value = "";
    } catch (err) { setDocError(err.message || "שגיאה בניתוח המסמך"); }
    setDocLoading(false);
  };

  const handleUrl = async () => {
    const url = docUrl.trim();
    if (!url.startsWith("http")) { setDocError("URL לא תקין"); return; }
    setUrlLoading(true); setDocError("");
    try {
      const form = await fillFormFromUrl(url);
      if (!form.title || form.title.length < 3) form.title = getTenderTitle(t);
      onAddDocs(t.id, form, []); setDocUrl("");
    } catch (err) { setDocError(err.message || "שגיאה בניתוח הקישור"); }
    setUrlLoading(false);
  };

  const title    = getTenderTitle(t);
  const value    = getTenderValue(t);
  const deadline = getTenderDeadline(t);
  const rec      = t.form?.rec_decision ? DM[t.form.rec_decision] : null;
  const dm       = t.yariv?.decision    ? DM[t.yariv.decision]    : null;

  const exportPdf = () => {
    const win = window.open("", "_blank");
    const fields = GONOGO_FIELDS.map(f => {
      const val = t.form?.[f.id] || "—";
      return `<tr><td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;background:#fff8f8;font-weight:700;color:#dc2626;font-size:11px;width:140px;vertical-align:top">${f.label}</td><td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#1e293b;white-space:pre-line">${val}</td></tr>`;
    }).join("");
    const decBadge = dm ? `<span style="background:${dm.bg};color:${dm.color};border:1px solid ${dm.border};padding:3px 12px;border-radius:6px;font-weight:800;font-size:13px">${dm.emoji} ${dm.label}</span>` : '<span style="color:#94a3b8;font-size:12px">ממתין להחלטה</span>';
    const recHtml = rec ? `<div style="margin-bottom:16px;padding:10px 14px;background:${rec.bg};border:1px solid ${rec.border};border-radius:8px"><b style="color:${rec.color}">${rec.emoji} המלצת AI: ${rec.label}</b> · ציון ${t.form.rec_score}/100 · סיכון: ${t.form.rec_risk}<br/><span style="font-size:11px;color:#475569">${t.form.rec_summary || ""}</span></div>` : "";
    win.document.write(`<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>${title}</title><link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;900&display=swap" rel="stylesheet"><style>body{font-family:'Heebo',sans-serif;padding:32px;color:#1e293b;max-width:800px;margin:0 auto}@media print{body{padding:16px}}</style></head><body><div style="border-bottom:3px solid #dc2626;padding-bottom:14px;margin-bottom:20px"><div style="font-size:11px;color:#64748b;margin-bottom:4px">מכרזי חטיבת בינוי PB ISRAEL · שאלון GO/NO-GO</div><div style="font-size:20px;font-weight:900;color:#0f172a;margin-bottom:6px">${title}</div><div style="font-size:12px;color:#64748b">💰 ${value} · 📅 הגשה: ${deadline}${t.url ? ` · <a href="${t.url}" style="color:#dc2626">${t.url}</a>` : ""}</div></div><div style="margin-bottom:20px"><b style="font-size:11px;color:#64748b">החלטת הצוות:</b><br/>${decBadge}${t.yariv?.notes ? `<div style="font-size:11px;color:#475569;margin-top:6px"><b>הערות:</b> ${t.yariv.notes}</div>` : ""}</div>${recHtml}${t.teamNotes ? `<div style="margin-bottom:16px;padding:10px 14px;background:#f8f9fb;border-radius:8px;font-size:12px"><b style="color:#64748b">💬 הערות הצוות:</b><br/>${t.teamNotes}</div>` : ""}<table style="width:100%;border-collapse:collapse;border:1.5px solid #e2e8f0;border-radius:8px;overflow:hidden">${fields}</table><div style="margin-top:20px;font-size:10px;color:#94a3b8;text-align:center">הופק: ${new Date().toLocaleString("he-IL")}</div><script>window.onload=()=>{window.print();}<\/script></body></html>`);
    win.document.close();
  };

  return (
    <div className="fu" style={{ background: "#ffffff", border: "1.5px solid rgba(220,38,38,0.45)", borderRadius: 13, padding: 20, position: "sticky", top: 70, maxHeight: "calc(100vh - 90px)", overflowY: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 0, paddingLeft: 10 }}>
          <div style={{ fontSize: 10.5, color: t.isManual ? "#a855f7" : t.source === "scan" ? "#34d399" : "#475569", marginBottom: 4, display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
            {t.isPdf ? `📄 ${t.pdfName || "PDF"}` : t.isManual ? "🔗 קישור ידני" : t.source === "scan" ? `🔍 ${t.sourceName || "סריקה"}` : `${src?.icon || ""} ${src?.name || ""}`}
            {t.form?.client && t.form.client !== "לא צוין" && <><span style={{ color: "#cbd5e1" }}>·</span><span>{t.form.client}</span></>}
          </div>
          <div style={{ fontSize: 15, fontWeight: 900, lineHeight: 1.4, color: "#0f172a", marginBottom: 4 }}>{title}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 5 }}>💰 {value} · 📅 הגשה: {deadline}</div>
          {t.url && <a href={t.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: "#dc2626", textDecoration: "none" }}>🔗 פתח מקור ↗</a>}
          {(t.docs || []).length > 0 && (
            <div style={{ marginTop: 8, background: "rgba(251,191,36,0.05)", border: "1px solid rgba(251,191,36,0.15)", borderRadius: 7, padding: "8px 10px" }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, color: "#92400e", marginBottom: 5 }}>📎 מסמכים שהועלו ({(t.docs || []).length})</div>
              {(t.docs || []).map((d, i) => <div key={i} style={{ fontSize: 11, color: "#fbbf24", marginBottom: 2 }}>📄 {d}</div>)}
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
          <button className="btn" onClick={onClose} style={{ background: "none", color: "#64748b", fontSize: 18, padding: "4px 4px" }}>✕</button>
          <button className="btn" onClick={exportPdf} style={{ background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.2)", color: "#dc2626", fontSize: 11, padding: "4px 7px", borderRadius: 6, fontWeight: 700 }}>📄 PDF</button>
        </div>
      </div>

      <div style={{ height: 1, background: "rgba(220,38,38,0.06)", marginBottom: 14 }} />

      {/* Add documents */}
      <div style={{ background: "#f1f5f9", border: "1px solid rgba(220,38,38,0.12)", borderRadius: 9, padding: 12, marginBottom: 14 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748b", marginBottom: 9 }}>📎 הוסף מסמכים — יעדכנו את השאלון</div>
        <div style={{ display: "flex", gap: 7, marginBottom: 7 }}>
          <div style={{ flex: 1, padding: "8px 11px", borderRadius: 7, border: "1px solid rgba(220,38,38,0.12)", background: "#f1f5f9", display: "flex", alignItems: "center", gap: 7, cursor: docLoading ? "default" : "pointer" }}
            onClick={() => !docLoading && !urlLoading && filesRef.current?.click()}>
            <span>📄</span>
            <span style={{ fontSize: 11.5, color: docLoading ? "#38bdf8" : "#64748b" }}>{docLoading ? "מנתח מסמכים..." : "העלה PDF (אפשר כמה קבצים)"}</span>
            {docLoading && <div style={{ width: 11, height: 11, border: "2px solid rgba(220,38,38,0.2)", borderTop: "2px solid #dc2626", borderRadius: "50%", animation: "spin 0.8s linear infinite", marginRight: "auto" }} />}
          </div>
          <input ref={filesRef} type="file" accept=".pdf" multiple style={{ display: "none" }} onChange={handleFiles} />
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          <input value={docUrl} onChange={e => { setDocUrl(e.target.value); setDocError(""); }}
            onKeyDown={e => e.key === "Enter" && !docLoading && !urlLoading && handleUrl()}
            placeholder="🔗 או הדבק קישור לעמוד/מסמך המכרז" disabled={docLoading || urlLoading}
            style={{ flex: 1, padding: "8px 11px", borderRadius: 7, border: "1px solid rgba(220,38,38,0.12)", background: "#f1f5f9", color: "#1e293b", fontSize: 12, fontFamily: "inherit", outline: "none" }} />
          <button className="btn" onClick={handleUrl} disabled={docLoading || urlLoading || !docUrl.trim()}
            style={{ padding: "8px 13px", borderRadius: 7, background: docLoading || urlLoading || !docUrl.trim() ? "rgba(56,189,248,0.05)" : "rgba(56,189,248,0.14)", color: docLoading || urlLoading || !docUrl.trim() ? "#334155" : "#38bdf8", fontWeight: 700, fontSize: 11.5, display: "flex", alignItems: "center", gap: 5 }}>
            {urlLoading ? <><div style={{ width: 10, height: 10, border: "2px solid rgba(220,38,38,0.2)", borderTop: "2px solid #dc2626", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />מנתח...</> : "נתח"}
          </button>
        </div>
        {docError && <div style={{ fontSize: 11, color: "#f87171", marginTop: 6 }}>{docError}</div>}
      </div>

      {/* Form fields */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 9 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#dc2626" }}>📋 שאלון GO/NO-GO</div>
        {!editMode
          ? <button className="btn" onClick={startEdit} style={{ fontSize: 10.5, color: "#64748b", background: "rgba(0,0,0,0.04)", border: "1px solid rgba(0,0,0,0.08)", padding: "3px 9px", borderRadius: 6, fontWeight: 600 }}>✏️ ערוך</button>
          : <div style={{ display: "flex", gap: 6 }}>
              <button className="btn" onClick={saveEdit} style={{ fontSize: 10.5, color: "white", background: "#dc2626", padding: "3px 10px", borderRadius: 6, fontWeight: 700 }}>💾 שמור</button>
              <button className="btn" onClick={() => setEditMode(false)} style={{ fontSize: 10.5, color: "#64748b", background: "rgba(0,0,0,0.06)", padding: "3px 9px", borderRadius: 6 }}>ביטול</button>
            </div>
        }
      </div>
      <div style={{ borderRadius: 9, overflow: "hidden", border: "1.5px solid rgba(0,0,0,0.15)", marginBottom: 16 }}>
        {GONOGO_FIELDS.map((f, i) => {
          const val = editMode ? (editForm[f.id] || "") : (t.form?.[f.id]);
          const hasVal = val && val !== "לא צוין";
          return (
            <div key={f.id} className="frow" style={{ display: "grid", gridTemplateColumns: "120px 1fr", borderBottom: i < GONOGO_FIELDS.length - 1 ? "1px solid rgba(56,189,248,0.15)" : "none" }}>
              <div style={{ padding: "8px 10px", borderLeft: "2px solid rgba(220,38,38,0.15)", background: "rgba(220,38,38,0.03)" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#dc2626", lineHeight: 1.3 }}>{f.label}</div>
                <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 1 }}>{f.hint}</div>
              </div>
              <div style={{ padding: "6px 10px" }}>
                {editMode
                  ? <textarea value={val} rows={2} onChange={e => setEditForm({ ...editForm, [f.id]: e.target.value })}
                      style={{ width: "100%", padding: "4px 7px", borderRadius: 5, border: "1px solid rgba(220,38,38,0.2)", background: "#fff", color: "#0f172a", fontSize: 11, fontFamily: "inherit", outline: "none", resize: "vertical", lineHeight: 1.5 }} />
                  : <div style={{ fontSize: 11.5, color: hasVal ? "#0f172a" : "#94a3b8", lineHeight: 1.7, whiteSpace: "pre-line" }}>{val || "—"}</div>
                }
              </div>
            </div>
          );
        })}
      </div>

      {/* AI Recommendation */}
      {rec && (
        <div style={{ background: "#f8f9fb", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 9, padding: 13, marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#64748b", marginBottom: 9 }}>🤖 המלצת המערכת <span style={{ fontWeight: 400, color: "#94a3b8" }}>(הצוות מחליט סופית)</span></div>
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", borderRadius: 7, background: rec.bg, border: `1px solid ${rec.border}`, marginBottom: 9 }}>
            <span style={{ fontSize: 18 }}>{rec.emoji}</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 900, color: rec.color }}>{rec.label}</div>
              <div style={{ fontSize: 10, color: "#64748b" }}>ציון {t.form.rec_score}/100 · סיכון: {t.form.rec_risk}</div>
            </div>
            <div style={{ flex: 1, fontSize: 11, color: "#64748b", lineHeight: 1.5, marginRight: 5 }}>{t.form.rec_summary}</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
            <div style={{ background: "rgba(52,211,153,0.04)", border: "1px solid rgba(52,211,153,0.1)", borderRadius: 6, padding: "8px 9px" }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, color: "#34d399", marginBottom: 4 }}>✅ יתרונות</div>
              {(t.form.rec_pros || []).map((p, i) => <div key={i} style={{ fontSize: 10.5, color: "#64748b", marginBottom: 2 }}>· {p}</div>)}
            </div>
            <div style={{ background: "rgba(248,113,113,0.04)", border: "1px solid rgba(248,113,113,0.1)", borderRadius: 6, padding: "8px 9px" }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, color: "#f87171", marginBottom: 4 }}>⚠️ חסרונות</div>
              {(t.form.rec_cons || []).map((c, i) => <div key={i} style={{ fontSize: 10.5, color: "#64748b", marginBottom: 2 }}>· {c}</div>)}
            </div>
          </div>
        </div>
      )}

      {/* Team notes */}
      <div style={{ background: "#f4f6f9", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 9, padding: 13, marginBottom: 12 }}>
        <div style={{ fontSize: 10.5, fontWeight: 800, color: "#64748b", marginBottom: 8 }}>💬 הערות הצוות</div>
        <textarea value={teamNotes} onChange={e => setTeamNotes(e.target.value)} rows={3}
          placeholder="הערות הצוות לפני ההחלטה — ניסיון קודם, כוח אדם, עדיפות עסקית..."
          style={{ width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid rgba(0,0,0,0.07)", background: "#f1f5f9", color: "#1e293b", fontSize: 11.5, fontFamily: "inherit", outline: "none", resize: "vertical", marginBottom: 8 }} />
        <button className="btn" onClick={saveTeam} style={{ padding: "6px 14px", borderRadius: 7, background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.2)", color: "#dc2626", fontWeight: 700, fontSize: 11 }}>
          {teamSaved ? "✅ נשמר" : "💾 שמור הערות"}
        </button>
      </div>

      {/* Team decision */}
      <div style={{ background: "rgba(220,38,38,0.04)", border: "1px solid rgba(220,38,38,0.25)", borderRadius: 10, padding: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#dc2626", marginBottom: 12 }}>🔐 החלטת הצוות</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 6, marginBottom: 10 }}>
          {[["go", "✅ GO", "#34d399", "rgba(52,211,153,0.12)", "rgba(52,211,153,0.45)"],
            ["conditional", "🟡 GO מותנה", "#fbbf24", "rgba(251,191,36,0.1)", "rgba(251,191,36,0.45)"],
            ["nogo", "❌ NO-GO", "#f87171", "rgba(248,113,113,0.1)", "rgba(248,113,113,0.45)"],
          ].map(([val, lbl, col, bg, brd]) => (
            <button key={val} className="btn" onClick={() => setDecision(val)}
              style={{ padding: "10px 6px", borderRadius: 8, border: `2px solid ${decision === val ? brd : "rgba(56,189,248,0.08)"}`, background: decision === val ? bg : "transparent", color: decision === val ? col : "#475569", fontWeight: 800, fontSize: 11.5, textAlign: "center" }}>
              {lbl}
            </button>
          ))}
        </div>
        <textarea value={yarivNotes} onChange={e => setYarivNotes(e.target.value)} rows={2}
          placeholder="הערות (אופציונלי)..."
          style={{ width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid rgba(220,38,38,0.12)", background: "#f1f5f9", color: "#1e293b", fontSize: 12, fontFamily: "inherit", outline: "none", resize: "vertical", marginBottom: 9 }} />
        <button className="btn" onClick={saveYarivDecision} disabled={!decision}
          style={{ width: "100%", padding: "10px", borderRadius: 8, background: decision ? "linear-gradient(135deg,#1e40af,#0369a1)" : "rgba(56,189,248,0.04)", color: decision ? "white" : "#2d3f55", fontWeight: 800, fontSize: 13 }}>
          {yarivSaved ? "✅ נשמר!" : decision ? "💾 שמור החלטה" : "בחר קודם GO / NO-GO"}
        </button>
        {t.yariv?.savedAt && (
          <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 7, textAlign: "center" }}>
            נשמר: {new Date(t.yariv.savedAt).toLocaleString("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
          </div>
        )}
      </div>
    </div>
  );
}
