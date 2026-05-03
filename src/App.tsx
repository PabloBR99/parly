import React, { useEffect } from 'react';
import { StatusBar } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LanguagePairScreen } from './screens/LanguagePairScreen';
import { ConversationScreen } from './screens/ConversationScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { LogsScreen } from './screens/LogsScreen';
import { audioCaptureService } from './services/audio/AudioCaptureService';
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

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App(): React.JSX.Element {
  const languagePairConfigured = useSettingsStore(s => s.languagePairConfigured);

  useEffect(() => {
    log.info('[App] mount — requesting permissions, initializing services');
    void audioCaptureService.requestPermission();
    void nativeTTSService.init();

    let unsubscribeApiKey: (() => void) | null = null;
    void loadMistralApiKey().then(key => {
      if (key) useSettingsStore.getState().setMistralApiKey(key);
      let lastSaved = key;
      unsubscribeApiKey = useSettingsStore.subscribe(state => {
        if (state.mistralApiKey !== lastSaved) {
          lastSaved = state.mistralApiKey;
          void saveMistralApiKey(lastSaved);
        }
      });
    });

    const networkMonitor = initNetworkMonitor({ probe: createMistralProbe() });
    networkMonitor.start();

    return () => {
      disposeNetworkMonitor();
      unsubscribeApiKey?.();
    };
  }, []);

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
