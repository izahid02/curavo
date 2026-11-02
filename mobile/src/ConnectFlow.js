/**
 * Connecting this phone to a shop:
 *   Welcome -> scan the QR on the shop PC -> name this phone -> wait while the
 *   shop PC checks the phone's proof -> connected.
 */
import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, Image, ScrollView, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import { clearLink, connect, getStatus, parseQr, saveLink } from './cloud';
import { Button, C, Card, Note, s } from './ui';

const LOGO = require('../assets/splash-icon.png');

export default function ConnectFlow({ pendingLink, onConnected }) {
  const [step, setStep] = useState(pendingLink ? 'waiting' : 'welcome');
  const [qr, setQr] = useState(null);
  const [link, setLink] = useState(pendingLink || null);
  const [error, setError] = useState('');

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 'scan' || step === 'name') { setStep('welcome'); return true; }
      return false;
    });
    return () => sub.remove();
  }, [step]);

  if (step === 'scan') {
    return (
      <Scanner
        onCancel={() => setStep('welcome')}
        onCode={(code) => {
          if (code.error) { setError(code.error); setStep('welcome'); return; }
          setQr(code); setError(''); setStep('name');
        }}
      />
    );
  }
  if (step === 'name') {
    return (
      <NamePhone
        qr={qr}
        onBack={() => setStep('welcome')}
        onSent={(l) => { setLink(l); setStep('waiting'); }}
      />
    );
  }
  if (step === 'waiting' && link) {
    return (
      <Waiting
        link={link}
        onActive={async () => { const l = { ...link, status: 'ACTIVE' }; await saveLink(l); onConnected(l); }}
        onRefused={async (reason) => { await clearLink(); setLink(null); setError(reason); setStep('welcome'); }}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 48, flexGrow: 1 }}>
      <Image source={LOGO} style={{ width: 72, height: 72, marginBottom: 20 }} />
      <Text style={s.h1}>Curavo Owner</Text>
      <Text style={[s.body, { marginTop: 8, marginBottom: 24 }]}>
        Your shop&apos;s sales, stock, expiry and patient credit - on your phone,
        wherever you are.
      </Text>

      {!!error && <Note tone="danger">{error}</Note>}

      <Card>
        <Text style={{ fontSize: 15, fontWeight: '700', color: C.text, marginBottom: 10 }}>To connect</Text>
        {[
          'On the shop PC, open Curavo and sign in as the owner.',
          'Click your name at the top right, then "Owner app on phone".',
          'Click "Connect a phone". A code appears on the screen.',
          'Tap the button below and point this phone at the code.',
        ].map((t, i) => (
          <View key={i} style={[s.row, { alignItems: 'flex-start', marginBottom: 8 }]}>
            <Text style={{ width: 22, color: C.accent, fontWeight: '700' }}>{i + 1}.</Text>
            <Text style={{ flex: 1, color: C.text, fontSize: 14, lineHeight: 20 }}>{t}</Text>
          </View>
        ))}
      </Card>

      <View style={{ flex: 1 }} />
      <Button title="Connect to my shop" onPress={() => { setError(''); setStep('scan'); }} />
      <Text style={{ textAlign: 'center', color: C.hint, fontSize: 12, marginTop: 14 }}>
        Only phones the shop PC approves can read the shop&apos;s figures.
      </Text>
    </ScrollView>
  );
}

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

function NamePhone({ qr, onBack, onSent }) {
  const guess = [Device.manufacturer, Device.modelName].filter(Boolean).join(' ') || 'My phone';
  const [name, setName] = useState(guess);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function go() {
    setBusy(true); setError('');
    try {
      onSent(await connect(qr, name.trim() || guess));
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 48 }} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>Connect to {qr.shopName || 'your shop'}?</Text>
      <Text style={[s.body, { marginTop: 8, marginBottom: 20 }]}>
        This phone will be able to see the shop&apos;s sales, stock and patient credit.
        The owner can remove it from the shop PC at any time.
      </Text>
      <Text style={{ fontSize: 13, fontWeight: '600', color: C.sub, marginBottom: 6 }}>Name for this phone</Text>
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
      if (Date.now() - started.current > 12 * 60 * 1000) {
        onRefused('The shop PC did not answer. Keep its "Owner app on phone" window open and try again.');
        return;
      }
      setTimeout(tick, 2000);
    }
    tick();
    return () => { stop = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
