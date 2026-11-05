/**
 * Connecting this phone to a shop.
 *
 * Usual way (decided 4 Nov 2026): sign in with the Curavo account (email +
 * password here, or Google through curavo.in) -> choose the shop -> name
 * this phone -> the shop PC shows Allow / Refuse with a 6-digit check code,
 * the same digits as on this phone -> connected.
 * Fallback: scan the QR code on the shop PC (account menu -> Owner app on phone).
 */
import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, Image, Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import {
  checkBrowserSignIn, clearAccount, clearLink, connect, connectWithAccount, getStatus, loadAccount,
  myShops, parseQr, saveLink, signInWithPassword, startBrowserSignIn,
} from './cloud';
import { Button, C, Card, Note, s } from './ui';

const LOGO = require('../assets/splash-icon.png');
const SITE = 'https://curavo.in';

export default function ConnectFlow({ pendingLink, onConnected }) {
  const [step, setStep] = useState(pendingLink ? 'waiting' : 'start');
  const [account, setAccount] = useState(null);
  const [shop, setShop] = useState(null);
  const [qr, setQr] = useState(null);
  const [link, setLink] = useState(pendingLink || null);
  const [error, setError] = useState('');

  // Signed in before (e.g. the PC refused once)?  Go straight to choosing the shop.
  useEffect(() => {
    if (pendingLink) return;
    loadAccount().then((acc) => { if (acc) { setAccount(acc); setStep('shops'); } else setStep('signin'); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const back = { scan: 'qrhelp', qrname: 'qrhelp', qrhelp: 'signin', browser: 'signin', name: 'shops' };
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (back[step]) { setStep(account && back[step] === 'signin' ? 'shops' : back[step]); return true; }
      return false;
    });
    return () => sub.remove();
  }, [step, account]);

  const signedIn = (acc) => { setAccount(acc); setError(''); setStep('shops'); };
  const signOut = async () => { await clearAccount(); setAccount(null); setStep('signin'); };

  if (step === 'start') return <View style={{ flex: 1, backgroundColor: C.bg }} />;
  if (step === 'browser') {
    return <BrowserSignIn onDone={signedIn} onCancel={(why) => { setError(why || ''); setStep('signin'); }} />;
  }
  if (step === 'shops' && account) {
    return <ChooseShop account={account} onPick={(sh) => { setShop(sh); setStep('name'); }} onSignOut={signOut}
      onExpired={async () => { await clearAccount(); setAccount(null); setError('Please sign in again.'); setStep('signin'); }}
      onQr={() => setStep('qrhelp')} error={error} />;
  }
  if (step === 'name' && shop) {
    return (
      <NamePhone
        shopName={shop.shop_name}
        connectFn={(name) => connectWithAccount(account, shop, name)}
        onBack={() => setStep('shops')}
        onSent={(l) => { setLink(l); setStep('waiting'); }}
      />
    );
  }
  if (step === 'scan') {
    return (
      <Scanner
        onCancel={() => setStep('qrhelp')}
        onCode={(code) => {
          if (code.error) { setError(code.error); setStep('qrhelp'); return; }
          setQr(code); setError(''); setStep('qrname');
        }}
      />
    );
  }
  if (step === 'qrname' && qr) {
    return (
      <NamePhone
        shopName={qr.shopName}
        connectFn={(name) => connect(qr, name)}
        onBack={() => setStep('qrhelp')}
        onSent={(l) => { setLink(l); setStep('waiting'); }}
      />
    );
  }
  if (step === 'waiting' && link) {
    return (
      <Waiting
        link={link}
        onActive={async () => { const l = { ...link, status: 'ACTIVE' }; await saveLink(l); onConnected(l); }}
        onRefused={async (reason) => {
          await clearLink(); setLink(null); setError(reason);
          const acc = await loadAccount();
          if (acc) { setAccount(acc); setStep('shops'); } else setStep(link.viaAccount ? 'signin' : 'qrhelp');
        }}
      />
    );
  }
  if (step === 'qrhelp') {
    return (
      <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 48, flexGrow: 1 }}>
        <Text style={s.h1}>Connect with a code</Text>
        <Text style={[s.body, { marginTop: 8, marginBottom: 20 }]}>Use this if you cannot sign in on this phone.</Text>
        {!!error && <Note tone="danger">{error}</Note>}
        <Card>
          {[
            'On the shop PC, open Curavo and sign in as the owner.',
            'Click your name at the top right, then "Owner app on phone".',
            'Click "Connect with a QR code". A code appears on the screen.',
            'Tap the button below and point this phone at the code.',
          ].map((t, i) => (
            <View key={i} style={[s.row, { alignItems: 'flex-start', marginBottom: 8 }]}>
              <Text style={{ width: 22, color: C.accent, fontWeight: '700' }}>{i + 1}.</Text>
              <Text style={{ flex: 1, color: C.text, fontSize: 14, lineHeight: 20 }}>{t}</Text>
            </View>
          ))}
        </Card>
        <View style={{ flex: 1 }} />
        <Button title="Scan the code" onPress={() => { setError(''); setStep('scan'); }} />
        <Button title="Back" kind="secondary" style={{ marginTop: 10 }} onPress={() => { setError(''); setStep(account ? 'shops' : 'signin'); }} />
      </ScrollView>
    );
  }
  return <SignIn error={error} onSignedIn={signedIn} onGoogle={() => { setError(''); setStep('browser'); }} onQr={() => { setError(''); setStep('qrhelp'); }} />;
}

function SignIn({ error, onSignedIn, onGoogle, onQr }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function go() {
    if (!email.trim() || !password) { setMsg('Enter your email and password.'); return; }
    setBusy(true); setMsg('');
    try { onSignedIn(await signInWithPassword(email, password)); }
    catch (e) { setMsg(e.message); setBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 44, flexGrow: 1 }} keyboardShouldPersistTaps="handled">
      <Image source={LOGO} style={{ width: 64, height: 64, marginBottom: 18 }} />
      <Text style={s.h1}>Curavo Owner</Text>
      <Text style={[s.body, { marginTop: 6, marginBottom: 22 }]}>
        Your shop&apos;s sales, stock, expiry and patient credit, on your phone. Sign in with your Curavo account.
      </Text>
      {!!(error || msg) && <Note tone="danger">{msg || error}</Note>}
      <Button title="Continue with Google" kind="secondary" onPress={onGoogle} disabled={busy} />
      <View style={[s.row, { marginVertical: 16 }]}>
        <View style={{ flex: 1, height: 1, backgroundColor: C.line }} />
        <Text style={{ marginHorizontal: 10, color: C.hint, fontSize: 12 }}>or with email</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: C.line }} />
      </View>
      <Text style={label}>Email</Text>
      <TextInput value={email} onChangeText={setEmail} style={s.input} autoCapitalize="none" autoComplete="email"
        keyboardType="email-address" textContentType="emailAddress" placeholder="you@example.com" />
      <Text style={[label, { marginTop: 12 }]}>Password</Text>
      <TextInput value={password} onChangeText={setPassword} style={s.input} secureTextEntry autoComplete="password"
        textContentType="password" onSubmitEditing={go} returnKeyType="go" />
      <Button title="Sign in" onPress={go} busy={busy} style={{ marginTop: 18 }} />
      <View style={[s.row, { justifyContent: 'space-between', marginTop: 16 }]}>
        <Pressable onPress={() => Linking.openURL(SITE + '/account#signup')} hitSlop={8}>
          <Text style={linkText}>Create an account</Text>
        </Pressable>
        <Pressable onPress={() => Linking.openURL(SITE + '/account')} hitSlop={8}>
          <Text style={linkText}>Forgot password?</Text>
        </Pressable>
      </View>
      <View style={{ flex: 1, minHeight: 24 }} />
      <Pressable onPress={onQr} hitSlop={8} style={{ alignSelf: 'center', padding: 8 }}>
        <Text style={[linkText, { color: C.sub }]}>Connect with a QR code instead</Text>
      </Pressable>
    </ScrollView>
  );
}

function BrowserSignIn({ onDone, onCancel }) {
  const [code, setCode] = useState(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let stop = false;
    let started = Date.now();
    let current = null;
    async function begin() {
      try {
        current = await startBrowserSignIn();
        if (stop) return;
        setCode(current);
        Linking.openURL(current.url);
        started = Date.now();
        tick();
      } catch (e) { onCancel(e.message); }
    }
    async function tick() {
      if (stop || !current) return;
      try {
        const r = await checkBrowserSignIn(current);
        if (r.status === 'APPROVED') { onDone(r.account); return; }
        if (r.status === 'REFUSED') { onCancel('Sign-in was not allowed.'); return; }
        if (r.status === 'EXPIRED' || r.status === 'USED') { onCancel('The sign-in code expired. Try again.'); return; }
        setMsg('');
      } catch (e) { setMsg(e.message); }
      if (Date.now() - started > 10 * 60 * 1000) { onCancel('The sign-in code expired. Try again.'); return; }
      setTimeout(tick, 2500);
    }
    begin();
    return () => { stop = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
      <Text style={s.h1}>Continue in the browser</Text>
      <Text style={[s.body, { marginTop: 8, marginBottom: 18 }]}>
        curavo.in opens. Sign in there with Google, then press Allow. Come back to this app afterwards; it continues by itself.
      </Text>
      {code && (
        <Card>
          <Text style={{ fontSize: 12, color: C.hint, textAlign: 'center' }}>Your code</Text>
          <Text style={{ fontSize: 28, fontWeight: '700', color: C.text, textAlign: 'center', letterSpacing: 3, marginTop: 4 }}>{code.code}</Text>
        </Card>
      )}
      {!!msg && <Note tone="warn">{msg}</Note>}
      {code && <Button title="Open curavo.in again" kind="secondary" onPress={() => Linking.openURL(code.url)} style={{ marginTop: 6 }} />}
      <Button title="Cancel" kind="secondary" onPress={() => onCancel('')} style={{ marginTop: 10 }} />
    </View>
  );
}

function ChooseShop({ account, onPick, onSignOut, onExpired, onQr, error }) {
  const [shops, setShops] = useState(null);
  const [msg, setMsg] = useState('');

  async function load() {
    setMsg(''); setShops(null);
    try { setShops(await myShops(account)); }
    catch (e) { if (e.status === 401) { onExpired(); return; } setMsg(e.message); setShops([]); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 44, flexGrow: 1 }}>
      <Text style={s.h1}>Choose your shop</Text>
      <Text style={[s.body, { marginTop: 6, marginBottom: 18 }]}>Signed in as {account.email || 'your Curavo account'}.</Text>
      {!!error && <Note tone="danger">{error}</Note>}
      {!!msg && <Note tone="warn">{msg}</Note>}
      {shops === null ? (
        <Text style={{ color: C.hint }}>Loading…</Text>
      ) : shops.length === 0 ? (
        <Card>
          <Text style={{ fontSize: 15, fontWeight: '700', color: C.text, marginBottom: 6 }}>No shop PC yet</Text>
          <Text style={{ color: C.sub, fontSize: 14, lineHeight: 20 }}>
            Install Curavo on the shop PC and sign in there with this account first (on the PC: Sign in with your
            Curavo account). Then come back here.
          </Text>
          <Button title="Check again" kind="secondary" onPress={load} style={{ marginTop: 14 }} />
        </Card>
      ) : shops.map((sh) => (
        <Pressable key={sh.shop_code} onPress={() => onPick(sh)} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}>
          <Card>
            <Text style={{ fontSize: 16, fontWeight: '700', color: C.text }}>{sh.shop_name}</Text>
            <Text style={{ fontSize: 12.5, color: C.hint, marginTop: 2 }}>Shop code {sh.shop_code}</Text>
            <Text style={{ color: C.accent, fontWeight: '600', marginTop: 10 }}>Connect this phone ›</Text>
          </Card>
        </Pressable>
      ))}
      <View style={{ flex: 1, minHeight: 24 }} />
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Pressable onPress={onSignOut} hitSlop={8}><Text style={[linkText, { color: C.sub }]}>Sign out</Text></Pressable>
        <Pressable onPress={onQr} hitSlop={8}><Text style={[linkText, { color: C.sub }]}>Use a QR code instead</Text></Pressable>
      </View>
    </ScrollView>
  );
}

const label = { fontSize: 13, fontWeight: '600', color: C.sub, marginBottom: 6 };
const linkText = { color: C.accent, fontWeight: '600', fontSize: 14 };

function Scanner({ onCode, onCancel }) {
  const [perm, requestPerm] = useCameraPermissions();
  const done = useRef(false);
  const [hint, setHint] = useState('');

  if (!perm) return <View style={{ flex: 1, backgroundColor: '#000' }} />;
  if (!perm.granted) {
    return (
      <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
        <Text style={s.h1}>Camera needed</Text>
        <Text style={[s.body, { marginVertical: 12 }]}>
          The camera is used only to read the code on the shop PC screen. Nothing is recorded.
        </Text>
        <Button title={perm.canAskAgain ? 'Allow camera' : 'Open settings to allow camera'} onPress={requestPerm} />
        <Button title="Back" kind="secondary" onPress={onCancel} style={{ marginTop: 10 }} />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return;
          const code = parseQr(data);
          if (!code) { setHint('That is not a Curavo code. Use the code from "Owner app on phone" on the shop PC.'); return; }
          done.current = true;
          onCode(code);
        }}
      />
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 20, paddingBottom: 36, backgroundColor: 'rgba(0,0,0,0.6)' }}>
        <Text style={{ color: '#fff', fontSize: 15, textAlign: 'center', marginBottom: 12 }}>
          {hint || 'Point the camera at the code on the shop PC'}
        </Text>
        <Button title="Cancel" kind="secondary" onPress={onCancel} />
      </View>
    </View>
  );
}

function NamePhone({ shopName, connectFn, onBack, onSent }) {
  const guess = [Device.manufacturer, Device.modelName].filter(Boolean).join(' ') || 'My phone';
  const [name, setName] = useState(guess);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function go() {
    setBusy(true); setError('');
    try {
      onSent(await connectFn(name.trim() || guess));
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 48 }} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>Connect to {shopName || 'your shop'}?</Text>
      <Text style={[s.body, { marginTop: 8, marginBottom: 20 }]}>
        This phone will be able to see the shop&apos;s sales, stock and patient credit.
        The owner can remove it from the shop PC at any time.
      </Text>
      <Text style={label}>Name for this phone</Text>
      <TextInput value={name} onChangeText={setName} maxLength={60} style={s.input} placeholder="e.g. Zahid's phone" />
      <Text style={{ fontSize: 12, color: C.hint, marginTop: 6, marginBottom: 20 }}>
        Shown on the shop PC, so you can tell your phones apart.
      </Text>
      {!!error && <Note tone="danger">{error}</Note>}
      <Button title="Connect" onPress={go} busy={busy} />
      <Button title="Cancel" kind="secondary" onPress={onBack} style={{ marginTop: 10 }} disabled={busy} />
    </ScrollView>
  );
}

function Waiting({ link, onActive, onRefused }) {
  const [msg, setMsg] = useState('');
  const started = useRef(Date.now());

  useEffect(() => {
    let stop = false;
    async function tick() {
      if (stop) return;
      try {
        const st = await getStatus(link);
        if (st.status === 'ACTIVE') { onActive(); return; }
        if (st.status === 'REMOVED') { onRefused(st.reason || 'The shop PC did not accept this phone.'); return; }
        setMsg('');
      } catch (e) {
        if (e.status === 401) { onRefused(e.message); return; }
        setMsg(e.message);
      }
      if (Date.now() - started.current > 16 * 60 * 1000) {
        onRefused(link.checkCode ? 'Nobody answered on the shop PC in time. Try again while Curavo is open there.'
          : 'The shop PC did not answer. Keep its "Owner app on phone" window open and try again.');
        return;
      }
      setTimeout(tick, 2000);
    }
    tick();
    return () => { stop = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (link.checkCode) {
    return (
      <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
        <Text style={s.h1}>Allow this phone on the shop PC</Text>
        <Text style={[s.body, { marginTop: 8, marginBottom: 18 }]}>
          Within a minute, Curavo on the shop PC shows &quot;A phone wants to connect&quot;. Check it shows this
          number, then press Allow there. Curavo must be open on the PC, signed in as the owner.
        </Text>
        <Card>
          <Text style={{ fontSize: 12, color: C.hint, textAlign: 'center' }}>Check code</Text>
          <Text style={{ fontSize: 34, fontWeight: '700', color: C.accent, textAlign: 'center', letterSpacing: 4, marginTop: 4 }}>{link.checkCode}</Text>
        </Card>
        {!!msg && <Note tone="warn">{msg}</Note>}
        <Button title="Cancel" kind="secondary" onPress={() => onRefused('')} />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
      <Text style={s.h1}>Waiting for the shop PC…</Text>
      <Text style={[s.body, { marginTop: 8, marginBottom: 20 }]}>
        The shop PC is checking this phone. Keep the &quot;Owner app on phone&quot; window open on the PC -
        this takes a few seconds.
      </Text>
      {!!msg && <Note tone="warn">{msg}</Note>}
      <Button title="Cancel" kind="secondary" onPress={() => onRefused('')} />
    </View>
  );
}
