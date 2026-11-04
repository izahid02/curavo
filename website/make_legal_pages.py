"""
Builds privacy.html, terms.html and refund.html from the text below, so the
three pages share one look and one place to edit.

    python3 website/make_legal_pages.py

The text is a DRAFT written for Curavo's actual behaviour (offline app, locked
cloud backups ARZ can open, licence keys, UPI payments).  Have it checked by a
lawyer or CA before the site goes live, then delete DRAFT_NOTE below.
Anything in [square brackets] must be filled in.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent
UPDATED = "4 November 2026"
DRAFT_NOTE = "Draft for review. Not yet checked by a lawyer."

NAME = "ARZ Solutions (a partnership firm)"
ADDRESS = "Bisandai Pt 1, Golakganj, Dhubri, Assam 783334"
EMAIL = "rausansheikh24@gmail.com"
WHATSAPP = "+91 69014 74078"
GRIEVANCE = "Rausan Sheikh, CEO"
COURTS = "Dhubri, Assam"


def ph(text):
    """A filled-in detail.  Anything still in [square brackets] is shown highlighted, to be filled."""
    if text.startswith("["):
        return f'<span class="ph">{text}</span>'
    return text


PAGES = {
    "privacy": ("Privacy policy", f"""
<p>This policy explains what information Curavo handles, where it is kept, and who can see it. Curavo is pharmacy software made by {ph(NAME)} ("ARZ", "we"). The pharmacy that uses Curavo is "you".</p>

<h2>1. Your pharmacy's data stays on your PC</h2>
<p>Curavo runs on your shop's own Windows PC. Your medicines, stock, bills, suppliers, patients and their purchase history are stored in a database file on that PC. Billing, stock and reports work without internet.</p>

<h2>2. What reaches ARZ</h2>
<ul>
<li><b>Daily cloud backup.</b> Once a day Curavo makes a copy of your database, together with your shop's logo and signature, and <b>locks (encrypts) it on your PC</b> before sending it to our cloud server. The server stores the locked file and cannot open it. Two keys can open it: your shop's own key, kept inside your Curavo, and ARZ's recovery key, kept offline by ARZ. We use the recovery key only to restore your data (for example when your PC is lost or damaged), when you ask us to, or when the law requires it. We keep backups for 30 days.</li>
<li><b>Check-ins.</b> About every 15 minutes Curavo tells our server your shop code, shop name, Curavo version, Windows version, subscription status, database size, free disk space and the number of bills made today. We use this to support you and to see that backups are working.</li>
<li><b>Error reports.</b> When Curavo crashes it sends a technical report: what failed, where in the program, and which screen. These reports can occasionally contain a short piece of text from your data. We use them only to fix Curavo.</li>
<li><b>Licence.</b> Your shop code and licence key, so your subscription can be checked and renewed.</li>
<li><b>Your Curavo account.</b> The shop owner's account on curavo.in: email address, name, shop name, phone, town and GSTIN (if entered), and the password - stored only in scrambled (hashed) form, so nobody at ARZ can read it. If you choose "Continue with Google", Google tells us your name and email address; we never see your Google password.</li>
<li><b>Owner app.</b> If the owner connects a phone, the shop PC sends a summary (today's sales, stock, expiry, patient credit) <b>locked so that only the owner's connected phones can open it</b> - not our server and not ARZ. Phone notifications say only how many items need attention, never amounts or names, because they pass through Google's notification service.</li>
<li><b>Website forms.</b> If you book a demo we receive your name, mobile number, shop name and town.</li>
</ul>

<h2>3. Patients' information</h2>
<p>Your patients' details belong to your pharmacy. For that information you decide what is collected and why, and ARZ handles it only on your behalf: to keep the locked backups and to restore them. We do not read, sell, share or use your patients' data for anything else, including marketing.</p>

<h2>4. Who we share information with</h2>
<p>Nobody, except: the hosting company that runs our server (Amazon Web Services; it stores only locked backups and the information in section 2); the email service that sends account emails (confirm your email, reset your password); Google, if you sign in with Google or receive owner-app notifications; a payment provider when you pay online; and authorities when the law requires it.</p>
<p><b>Where the server is.</b> During the pilot our server runs in Amazon's data centre in Sydney, Australia. We will move it to India before Curavo is offered to everyone and will update this page when we do.</p>

<h2>5. Security</h2>
<p>Backups are encrypted with AES-256 on your PC before upload. Licence keys and app updates are digitally signed, so they cannot be forged. Access to our server and control panel is limited to ARZ staff.</p>

<h2>6. Your choices</h2>
<ul>
<li>You can ask for a copy of what we hold about your shop, ask us to correct it, or ask us to delete your cloud backups and records when you stop using Curavo.</li>
<li>Your data on your PC is yours. You can keep using and exporting it whatever happens to your subscription.</li>
</ul>

<h2>7. Grievance officer</h2>
<p>For any question or complaint about privacy, contact our grievance officer, {ph(GRIEVANCE)}, at {ph(EMAIL)} or WhatsApp {ph(WHATSAPP)}. Address: {ph(ADDRESS)}. We acknowledge every complaint within 2 working days and reply within 7 working days.</p>

<h2>8. Changes</h2>
<p>If we change this policy we will update this page and the date at the top, and tell you in Curavo if the change matters to you.</p>
"""),

    "terms": ("Terms of service", f"""
<p>These terms are an agreement between {ph(NAME)} ("ARZ", "we") and the pharmacy using Curavo ("you"). By installing or using Curavo you accept them.</p>

<h2>1. What you get</h2>
<p>A licence to use Curavo on one Windows PC at your pharmacy, with updates, daily cloud backup and support on WhatsApp, for as long as your trial or subscription is active.</p>

<h2>2. Free trial</h2>
<p>A new installation gets a 30-day free trial with every feature. No payment details are needed.</p>

<h2>3. Subscription and payment</h2>
<ul>
<li>Plans: monthly ₹589, half-yearly ₹2,899, yearly ₹4,999. Prices include 18% GST.</li>
<li>You pay in advance for the period. After payment your subscription reaches your shop PC by itself through your Curavo account (or we send a licence key for your shop).</li>
<li>We may change prices for future periods with at least 30 days' notice. A period you have already paid for keeps its price.</li>
</ul>

<h2>4. When a subscription ends</h2>
<p>Billing keeps working, so your patients are always served. After a 15-day grace period, reports, exports and backup downloads pause until you renew. Your data stays on your PC.</p>

<h2>5. Your responsibilities</h2>
<ul>
<li>Check that prices, GST rates, HSN codes and the Schedule H1 register are correct for your shop. Curavo calculates from what you enter.</li>
<li>Keep your PC in working order, and your Curavo account and PC passwords private. Change the PC's default password after installing.</li>
<li>Do not copy Curavo to another shop, share your licence key, or try to get around the licence check.</li>
</ul>

<h2>6. Your data</h2>
<p>Your pharmacy's data belongs to you. How we handle it is described in the <a href="privacy.html">privacy policy</a>.</p>

<h2>7. Availability and liability</h2>
<p>We work to keep Curavo reliable and to fix problems quickly, but we cannot promise it will be free of every error. To the extent the law allows, our total liability for any claim is limited to the amount you paid us in the 12 months before the claim. We are not liable for indirect losses such as lost profit.</p>

<h2>8. Ending the agreement</h2>
<p>You can stop using Curavo at any time. We may end this agreement if you break these terms, for example by sharing your licence key.</p>

<h2>9. Law</h2>
<p>These terms are governed by the laws of India. Courts at {ph(COURTS)} have jurisdiction.</p>

<h2>10. Contact</h2>
<p>{ph(NAME)}, {ph(ADDRESS)}. Email {ph(EMAIL)}, WhatsApp {ph(WHATSAPP)}.</p>
"""),

    "refund": ("Refunds and cancellations", f"""
<p>Curavo gives every new pharmacy a 30-day free trial with all features, so you can decide before paying anything.</p>

<h2>Cancelling</h2>
<p>There is nothing to cancel: Curavo is not renewed automatically unless you set up AutoPay. If you don't renew, your subscription simply ends at the end of the period you paid for. Billing keeps working after that; see the <a href="terms.html">terms of service</a>.</p>

<h2>Refunds</h2>
<ul>
<li><b>Within 7 days of a payment:</b> if Curavo is not working for you, ask us and we refund the full amount.</li>
<li><b>After 7 days:</b> payments are not refunded for the rest of the current period.</li>
<li><b>Paid twice by mistake:</b> we refund the extra payment in full.</li>
</ul>
<p>Refunds go back to the account you paid from within 7 working days of approval.</p>

<h2>How to ask</h2>
<p>WhatsApp {ph(WHATSAPP)} or email {ph(EMAIL)} with your shop name and shop code (shown in Curavo under Licence &amp; subscription).</p>
"""),
}

TEMPLATE = """<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title} · Curavo</title>
<link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap">
<style>
:root {{ --paper:#f5f6fd; --ink:#1e1b4b; --ink-2:#4b5068; --accent:#4f46e5; --line:rgba(30,27,75,0.10); color-scheme: light; }}
* {{ box-sizing: border-box; }}
body {{ margin:0; background:var(--paper); color:var(--ink); font:17px/1.65 'Outfit','Segoe UI',system-ui,sans-serif; -webkit-font-smoothing:antialiased; }}
.wrap {{ max-width: 760px; margin: 0 auto; padding-left: max(20px, env(safe-area-inset-left, 0px)); padding-right: max(20px, env(safe-area-inset-right, 0px)); padding-block: 28px 80px; }}
a {{ color: var(--accent); }}
.back {{ display:inline-flex; gap:8px; align-items:center; text-decoration:none; color:var(--ink); font-weight:600; font-size:18px; }}
.back svg {{ width:30px; height:30px; }}
h1 {{ font-size: clamp(32px, 5vw, 44px); line-height:1.15; letter-spacing:-0.02em; margin: 36px 0 6px; }}
.meta {{ color: var(--ink-2); font-size: 15px; margin-bottom: 26px; }}
.draft {{ background:#fef3c7; color:#92400e; border-radius:10px; padding:10px 14px; font-size:15px; margin-bottom:24px; }}
h2 {{ font-size: 21px; margin: 32px 0 8px; letter-spacing:-0.01em; }}
p, li {{ color: #2d2a55; }}
ul {{ padding-left: 22px; display:grid; gap:8px; }}
.ph {{ background:#fef3c7; color:#92400e; border-radius:4px; padding:0 4px; }}
footer {{ border-top:1px solid var(--line); margin-top:48px; padding-top:18px; font-size:14px; color:var(--ink-2); display:flex; gap:18px; flex-wrap:wrap; }}
footer a {{ color: var(--ink-2); }}
</style>
</head>
<body>
<div class="wrap">
  <a class="back" href="index.html"><svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="url(#g)"/><rect x="26" y="12" width="12" height="40" rx="4.5" fill="#fff"/><rect x="12" y="26" width="40" height="12" rx="4.5" fill="#fff"/><path d="M13 43 Q25 31 32 34 Q39 37 51 24" stroke="#6ee7b7" stroke-width="5" stroke-linecap="round" fill="none"/></svg>Curavo</a>
  <h1>{title}</h1>
  <p class="meta">Last updated {updated}</p>
  {draft}
  {body}
  <footer><a href="privacy.html">Privacy policy</a><a href="terms.html">Terms of service</a><a href="refund.html">Refunds and cancellations</a><a href="index.html">Back to Curavo</a></footer>
</div>
</body>
</html>
"""

for slug, (title, body) in PAGES.items():
    draft = f'<p class="draft">{DRAFT_NOTE}</p>' if DRAFT_NOTE else ""
    (HERE / f"{slug}.html").write_text(
        TEMPLATE.format(title=title, updated=UPDATED, draft=draft, body=body.strip()), encoding="utf-8")
    print("wrote", f"{slug}.html")
