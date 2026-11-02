/**
 * Curavo Owner - the shop owner's Android app.
 *
 * Not connected -> ConnectFlow (scan the QR on the shop PC).
 * Connected     -> Shop (Today, Stock, Credit, More).
 * The link lives in the phone's secure storage (src/cloud.js).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { clearLink, loadLink, saveLink, sendPushToken } from './cloud';
import ConnectFlow from './ConnectFlow';
import Shop from './Shop';
import { C, Note } from './ui';

// Show the morning alert even if the app happens to be open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false,
  }),
});

/**
 * Ask for permission and register this phone for the morning alert.
 * Returns 'on' or 'unavailable'.  Never throws: the app works without it.
 */
async function enablePush(link) {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Shop alerts', importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    const perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return 'unavailable';
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return 'unavailable';
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    await sendPushToken(link, data);
    return 'on';
  } catch {
    return 'unavailable';
  }
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [link, setLink] = useState(null);
  const [notice, setNotice] = useState('');
  const [push, setPush] = useState('off');

  useEffect(() => {
    loadLink().then((l) => { setLink(l); setReady(true); });
  }, []);

  // Once connected, turn on the morning alert (asks the first time only).
  useEffect(() => {
    if (link?.status !== 'ACTIVE') return;
    if (link.push === 'on') { setPush('on'); return; }
    enablePush(link).then(async (st) => {
      setPush(st);
      if (st === 'on') { const l = { ...link, push: 'on' }; await saveLink(l); }
    });
  }, [link?.deviceId, link?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const disconnected = useCallback(async (why) => {
    await clearLink();
    setLink(null);
    setPush('off');
    setNotice(why || '');
  }, []);

  if (!ready) return <View style={{ flex: 1, backgroundColor: C.bg }} />;

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {link?.status === 'ACTIVE' ? (
        <Shop
          link={link}
          notifications={push}
          onEnableNotifications={async () => setPush(await enablePush(link))}
          onDisconnected={disconnected}
        />
      ) : (
        <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
          {!!notice && <View style={{ padding: 16, paddingBottom: 0 }}><Note tone="warn">{notice}</Note></View>}
          <ConnectFlow pendingLink={link} onConnected={(l) => { setNotice(''); setLink(l); }} />
        </SafeAreaView>
      )}
    </SafeAreaProvider>
  );
}
