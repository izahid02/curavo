"""
Account emails (verify your address, reset your password).

With CURAVO_SMTP_HOST set, mail goes out through that sending service (any
provider that offers SMTP - Amazon SES, Brevo, Resend, Zoho...).  Without it,
each email is written to <data>/outbox/ as a .eml file, so everything can be
tested before an email service exists.  A failure to send is logged, never
raised: a sign-up must not crash because the mail service is down.
"""
import logging
import smtplib
import ssl
from datetime import datetime
from email.message import EmailMessage

from curavo_cloud.config import settings

log = logging.getLogger("curavo.mail")


def _smtp_send(msg: EmailMessage):
    ctx = ssl.create_default_context()
    if settings.smtp_port == 465:
        with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, context=ctx, timeout=20) as s:
            if settings.smtp_user:
                s.login(settings.smtp_user, settings.smtp_password)
            s.send_message(msg)
    else:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as s:
            s.starttls(context=ctx)
            if settings.smtp_user:
                s.login(settings.smtp_user, settings.smtp_password)
            s.send_message(msg)


def _outbox_send(msg: EmailMessage):
    settings.outbox_dir.mkdir(parents=True, exist_ok=True)
    name = datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f") + ".eml"
    (settings.outbox_dir / name).write_bytes(bytes(msg))


def _default_sender(msg: EmailMessage):
    (_smtp_send if settings.smtp_host else _outbox_send)(msg)


# Replaced by the guard test, which reads what would have been sent.
sender = _default_sender


def send(to: str, subject: str, text: str) -> bool:
    msg = EmailMessage()
    msg["From"] = settings.mail_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    try:
        sender(msg)
        return True
    except Exception as e:
        log.warning("Email to %s not sent: %s", to.split("@")[-1], type(e).__name__)
        return False
