import React, { useEffect, useState } from 'react';
import { StatusBar, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LanguagePairScreen } from './screens/LanguagePairScreen';
import { ConversationScreen } from './screens/ConversationScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { LogsScreen } from './screens/LogsScreen';
import { nativeTTSService } from './services/tts/NativeTTSService';
import { initNetworkMonitor, disposeNetworkMonitor } from './services/network/monitor';
import { createMistralProbe } from './services/network/mistralProbe';
import { loadMistralApiKey, saveMistralApiKey } from './services/storage/secureStorage';
import { initLogStore, log } from './services/log/logStore';
import { useSettingsStore } from './store/settingsStore';
import type { RootStackParamList } from './navigation/types';
import { color } from './ui';

// Kick off log store at module load so we capture errors as early as possible.
void initLogStore();

// Debounce keychain writes: the onboarding input feeds the store per
// keystroke, and each write serializes through the OS keychain. One write
// half a second after typing stops is enough.
const KEYCHAIN_SAVE_DEBOUNCE_MS = 500;

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App(): React.JSX.Element {
  const languagePairConfigured = useSettingsStore(s => s.languagePairConfigured);
  // Settings persist to disk asynchronously; hold navigation until the
  // rehydrate lands so a returning user opens on Conversation, not on an
  // empty LanguagePair flash. (Mic permission is requested lazily on first
  // PTT press — with context — not fire-and-forget here.)
  const [hydrated, setHydrated] = useState(useSettingsStore.persist.hasHydrated());

  useEffect(() => {
    const unsub = useSettingsStore.persist.onFinishHydration(() => setHydrated(true));
    if (useSettingsStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);

  useEffect(() => {
    log.info('[App] mount — initializing services');
    void nativeTTSService.init();

    let unsubscribeApiKey: (() => void) | null = null;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    void loadMistralApiKey().then(key => {
      if (key) useSettingsStore.getState().hydrateMistralApiKey(key);
      let lastSaved = key;
      unsubscribeApiKey = useSettingsStore.subscribe(state => {
        if (state.mistralApiKey !== lastSaved) {
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            saveTimer = null;
            // Read the live value: a pending save must never clobber the
            // keychain with an intermediate keystroke state.
            const current = useSettingsStore.getState().mistralApiKey;
            lastSaved = current;
            void saveMistralApiKey(current);
          }, KEYCHAIN_SAVE_DEBOUNCE_MS);
        }
      });
    });

    const networkMonitor = initNetworkMonitor({ probe: createMistralProbe() });
    networkMonitor.start();

    return () => {
      disposeNetworkMonitor();
      unsubscribeApiKey?.();
      if (saveTimer) clearTimeout(saveTimer);
    };
  }, []);

  if (!hydrated) {
    return <View style={splashStyle} />;
  }

  return (
    <ErrorBoundary>
    <GestureHandlerRootView style={gestureRootStyle}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor={color.bg} />
        <NavigationContainer>
          <Stack.Navigator
            initialRouteName={languagePairConfigured ? 'Conversation' : 'LanguagePair'}
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: color.bg },
              animation: 'fade',
              animationDuration: 220,
            }}>
            <Stack.Screen name="LanguagePair" component={LanguagePairScreen} />
            <Stack.Screen name="Conversation" component={ConversationScreen} />
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: color.bg },
                headerTintColor: color.fgMuted,
                headerTitleStyle: { fontWeight: '400', fontSize: 16 },
                headerTitle: '',
                headerBackTitle: '',
                headerShadowVisible: false,
                animation: 'slide_from_bottom',
              }}
            />
            <Stack.Screen
              name="Logs"
              component={LogsScreen}
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: color.bg },
                headerTintColor: color.fgMuted,
                headerTitleStyle: { fontWeight: '400', fontSize: 16 },
                headerTitle: 'Logs',
                headerBackTitle: '',
                headerShadowVisible: false,
                animation: 'slide_from_right',
              }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

const gestureRootStyle = { flex: 1 };
const splashStyle = { flex: 1, backgroundColor: color.bg };
