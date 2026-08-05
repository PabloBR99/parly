// LogsScreen — temporary diagnostic surface.
//
// Displays the in-memory log buffer (which mirrors the disk file). On every
// new entry, auto-scrolls to the bottom. Provides Share + Clear actions so
// the user can dump the trail to a chat, email, or notes app.
//
// This screen is meant to be deleted once the production crash is solved.

import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  clearLogs,
  exportLogsAsText,
  subscribeLogs,
  type LogEntry,
} from '../services/log/logStore';
import type { RootStackParamList } from '../navigation/types';
import { Button, Surface, Text, color, radius, space } from '../ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Logs'>;

export function LogsScreen(_props: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [entries, setEntries] = useState<readonly LogEntry[]>([]);
  const scrollRef = useRef<ScrollView | null>(null);

  useEffect(() => {
    const unsub = subscribeLogs(setEntries);
    return unsub;
  }, []);

  // Auto-scroll to bottom whenever a new entry lands.
  useEffect(() => {
    const id = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    }, 50);
    return () => clearTimeout(id);
  }, [entries.length]);

  const onShare = async () => {
    try {
      await Share.share({
        title: 'Parly logs',
        message: exportLogsAsText(),
      });
    } catch {
      // ignore
    }
  };

  const onClear = () => {
    clearLogs();
  };

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom }]}>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}>
        <Text variant="caption" tone="fgFaint" style={styles.eyebrow}>
          PARLY  ·  DIAGNOSTICS  ·  {entries.length} entries
        </Text>
        {entries.length === 0 ? (
          <Text variant="body" tone="fgFaint" style={styles.empty}>
            No entries yet.
          </Text>
        ) : (
          <Surface style={styles.list}>
            {entries.map((e, idx) => (
              <LogRow key={e.id} entry={e} isLast={idx === entries.length - 1} />
            ))}
          </Surface>
        )}
      </ScrollView>

      <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
        <Button label="Share" variant="primary" onPress={onShare} style={styles.barCta} />
        <Button label="Clear" variant="danger"  onPress={onClear} style={styles.barCta} />
      </View>
    </View>
  );
}

interface LogRowProps {
  readonly entry: LogEntry;
  readonly isLast: boolean;
}

function LogRow({ entry, isLast }: LogRowProps): React.JSX.Element {
  const tone: 'error' | 'warn' | 'fgMuted' | 'fgFaint' =
    entry.level === 'error' ? 'error'
      : entry.level === 'warn' ? 'warn'
      : entry.level === 'info' ? 'fgMuted'
      : 'fgFaint';
  const time = formatTime(entry.timestamp);
  return (
    <View style={[styles.row, !isLast && styles.rowDivider]}>
      <View style={styles.rowHead}>
        <Text variant="mono" tone="fgGhost">
          {time}  +{entry.relativeMs}ms
        </Text>
        <Text variant="mono" tone={tone === 'error' ? 'error' : tone === 'warn' ? 'warn' : 'fgGhost'}>
          {entry.level.toUpperCase()}
        </Text>
      </View>
      <Text variant="bodySmall" tone={tone} selectable style={styles.rowMessage}>
        {entry.message}
      </Text>
      {entry.stack && (
        <Text variant="mono" tone="fgFaint" selectable style={styles.rowStack}>
          {entry.stack}
        </Text>
      )}
    </View>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w: number = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.lg,
  },
  eyebrow: {
    marginBottom: space.sm,
  },
  empty: {
    paddingVertical: space.xxl,
    textAlign: 'center',
  },
  list: {
    padding: 0,
    borderRadius: radius.md,
  },
  row: {
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  rowHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  rowMessage: {
    fontFamily: 'monospace',
    lineHeight: 17,
  },
  rowStack: {
    marginTop: 4,
    opacity: 0.75,
  },
  bar: {
    flexDirection: 'row',
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
    backgroundColor: color.bg,
    gap: space.sm,
  },
  barCta: {
    flex: 1,
  },
});
