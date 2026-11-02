# Curavo Owner (Android app)

The shop owner's phone app: today's sales, needs-attention, stock lookup,
patient credit, and a morning alert.  It only READS figures the shop PC
sends; it cannot change anything at the shop.

How it fits together (details in CLAUDE.md, "THE OWNER APP'S FIGURES ARE LOCKED"):

    shop PC  --locked summary every 5 min-->  Curavo cloud  -->  this app
                                                   (cannot read it)

| File | What it does |
|---|---|
| `src/App.js` | Connected or not; turns on the morning alert |
| `src/ConnectFlow.js` | Scan the QR on the shop PC, name the phone, wait for approval |
| `src/Shop.js` | Today / Stock / Credit / More screens |
| `src/cloud.js` | Talking to the cloud; the saved link in secure storage |
| `src/lockbox.js` | The crypto - must match `backend/app/services/owner_app.py` |
| `scripts/check_lockbox.mjs` | Lets `backend/scripts/test_owner_app.py` run lockbox.js |

## Try it on your phone today (no build, Expo Go)

1. Install **Expo Go** from the Play Store on an Android phone.
2. Mac and phone on the same Wi-Fi.  Find the Mac's address:
   `ipconfig getifaddr en0` (say it prints 192.168.1.20).
3. Start a test cloud and a shop that uses it (two Terminal windows):

       cd ~/Projects/curavo/cloud/server
       CURAVO_CLOUD_DATA=/tmp/curavo-cloud CURAVO_ADMIN_PASSWORD=test1234 \
         python3 -m uvicorn curavo_cloud.main:app --host 0.0.0.0 --port 8100

       cd ~/Projects/curavo/backend
       CURAVO_CLOUD_URL=http://192.168.1.20:8100 HCC_DATA_DIR=/tmp/hcc-test \
         uvicorn app.main:app --port 8000

   (and `npm run dev` in frontend/ as usual).  Wait one minute so the shop
   joins the test cloud.
4. Start the app:  `cd mobile && npm install && npx expo start`
   and scan the QR it prints with Expo Go.
5. On the shop screen: your name -> Owner app on phone -> Connect a phone,
   and scan that code with the app.

A test server on plain `http://` is accepted only in this development mode.
The real APK insists on `https://` (cloud.curavo.in).  The morning alert does
not work in Expo Go - it needs the real APK (below).

## Build the APK (free Expo account)

Once, on the Mac:

    cd ~/Projects/curavo/mobile
    npm install
    npx eas-cli@latest login            # your free expo.dev account
    npx eas-cli@latest init             # writes the project id into app.json - commit it

Every build:

    npx eas-cli@latest build -p android --profile apk

It builds in Expo's cloud (10-20 minutes) and prints a download link for the
`.apk`.  Install it on a phone by opening that link on the phone (Android asks
to allow "install unknown apps" for the browser - that is expected for an app
that is not from the Play Store yet).

**The signing key.**  The first build asks to generate an Android keystore -
say yes; Expo keeps it.  Then download a copy with
`npx eas-cli@latest credentials` -> Android -> Download, and keep it in
`~/Projects/ARZ-licence-keys/`.  Every future update, and the Play Store
later, must be signed with this same key, or phones refuse the update.

**Morning alert (notifications).**  Android delivers them through Google's
Firebase.  Until it is set up the app works fine and More -> Morning alert
says it could not be turned on.  To set it up: create a free Firebase
project, add an Android app with package `in.curavo.owner`, and upload its
"service account key" to Expo with `npx eas-cli@latest credentials`
(Android -> FCM V1).  Then build again.

For each new version raise `version` and `android.versionCode` in app.json.

## Play Store later

`npx eas-cli@latest build -p android --profile playstore` makes the `.aab`
the Play Store wants.  Needs a Google Play developer account (one-time fee),
a privacy policy URL (website/privacy.html) and the store listing.
