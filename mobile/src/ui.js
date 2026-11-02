/** Colours and small building blocks, matching the Curavo desktop app. */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

export const C = {
  bg: '#f4f3fb',
  card: '#ffffff',
  line: '#e7e5f4',
  text: '#1e1b4b',
  sub: '#6b7280',
  hint: '#9ca3af',
  accent: '#6366f1',
  accentDark: '#4f46e5',
  accentSoft: 'rgba(99,102,241,0.10)',
  ok: '#059669', okBg: 'rgba(16,185,129,0.12)',
  warn: '#b45309', warnBg: 'rgba(245,158,11,0.14)',
  danger: '#e11d48', dangerBg: 'rgba(244,63,94,0.12)',
  info: '#0284c7', infoBg: 'rgba(14,165,233,0.12)',
};

export function Card({ children, style }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Label({ children, style }) {
  return <Text style={[s.label, style]}>{children}</Text>;
}

export function Button({ title, onPress, kind = 'primary', disabled, busy, style }) {
  const primary = kind === 'primary';
  const danger = kind === 'danger';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        s.btn,
        primary && { backgroundColor: pressed ? C.accentDark : C.accent },
        !primary && { backgroundColor: pressed ? C.line : C.card, borderWidth: 1, borderColor: danger ? C.danger : C.line },
        (disabled || busy) && { opacity: 0.55 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={primary ? '#fff' : C.accent} />
        : <Text style={[s.btnText, { color: primary ? '#fff' : danger ? C.danger : C.text }]}>{title}</Text>}
    </Pressable>
  );
}

export function Note({ tone = 'info', children, style }) {
  const [bg, fg] = { ok: [C.okBg, C.ok], warn: [C.warnBg, C.warn], danger: [C.dangerBg, C.danger], info: [C.infoBg, C.info] }[tone];
  return (
    <View style={[s.note, { backgroundColor: bg }, style]}>
      <Text style={{ color: fg, fontSize: 13.5, lineHeight: 19 }}>{children}</Text>
    </View>
  );
}

export function Badge({ tone = 'info', children }) {
  const [bg, fg] = { ok: [C.okBg, C.ok], warn: [C.warnBg, C.warn], danger: [C.dangerBg, C.danger], info: [C.infoBg, C.info], accent: [C.accentSoft, C.accent] }[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <Text style={{ color: fg, fontSize: 11.5, fontWeight: '600' }}>{children}</Text>
    </View>
  );
}

export const s = StyleSheet.create({
  card: {
    backgroundColor: C.card, borderRadius: 16, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: C.line,
  },
  label: {
    fontSize: 11.5, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', color: C.hint, marginBottom: 8,
  },
  btn: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 15.5, fontWeight: '600' },
  note: { borderRadius: 12, padding: 12, marginBottom: 12 },
  h1: { fontSize: 24, fontWeight: '700', color: C.text },
  body: { fontSize: 14.5, color: C.sub, lineHeight: 21 },
  row: { flexDirection: 'row', alignItems: 'center' },
  input: {
    backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 11, fontSize: 15, color: C.text,
  },
});
