import React, { useEffect } from 'react';
import { StatusBar } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ConversationScreen } from './screens/ConversationScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { initModels } from './services/models/ModelManager';
import { warmupTranslation } from './services/pipeline/PipelineOrchestrator';
import { nativeTTSService } from './services/tts/NativeTTSService';
import { memoryMonitor } from './services/memory/MemoryMonitor';
import { useModelStore } from './store/modelStore';
import { audioCaptureService } from './services/audio/AudioCaptureService';
import { initNetworkMonitor, disposeNetworkMonitor } from './services/network/monitor';
import { createMistralProbe } from './services/network/mistralProbe';
import { loadMistralApiKey, saveMistralApiKey } from './services/storage/secureStorage';
import { useSettingsStore } from './store/settingsStore';
import type { RootStackParamList } from './navigation/types';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App(): React.JSX.Element {
  useEffect(() => {
    // Request mic permission early — VAD auto-starts after models load
    void audioCaptureService.requestPermission();

    // Warm OS TTS so it's ready when the first translation arrives
    void nativeTTSService.init();

    // Start model download/load in background
    void initModels()
      .then(() => void warmupTranslation().catch(() => {}))
      .catch(err => {
        console.error('[App] Model init failed:', err);
        useModelStore.getState().setWhisperError(
          err instanceof Error ? err.message : String(err),
        );
      });

    memoryMonitor.start(15_000);

    // Hydrate the Mistral API key from secure storage BEFORE starting the
    // network monitor — otherwise the first probe would go unauthenticated
    // and the resolver would delay the online decision by one cycle.
    let unsubscribeApiKeyPersist: (() => void) | null = null;
    void loadMistralApiKey().then(key => {
      if (key) useSettingsStore.getState().setMistralApiKey(key);
      // Persist subsequent user edits. Fire-and-forget; errors are logged.
      let lastSaved = key;
      unsubscribeApiKeyPersist = useSettingsStore.subscribe(state => {
        if (state.mistralApiKey !== lastSaved) {
          lastSaved = state.mistralApiKey;
          void saveMistralApiKey(lastSaved);
        }
      });
    });

    // Network monitor — drives online/offline routing in the STT resolver.
    // Probes Mistral directly so 'online' means "Voxtral is reachable", not
    // just "any internet". Starts immediately; first probe resolves within ~3s.
    const networkMonitor = initNetworkMonitor({ probe: createMistralProbe() });
    networkMonitor.start();

    return () => {
      memoryMonitor.stop();
      disposeNetworkMonitor();
      unsubscribeApiKeyPersist?.();
    };
  }, []);

  return (
    <GestureHandlerRootView style={gestureRootStyle}>
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <NavigationContainer>
        <Stack.Navigator
          initialRouteName="Conversation"
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: '#000000' },
            animation: 'fade',
          }}>
          <Stack.Screen
            name="Conversation"
            component={ConversationScreen}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{
              headerShown: true,
              headerStyle: { backgroundColor: '#000000' },
              headerTintColor: 'rgba(255,255,255,0.5)',
              headerTitleStyle: { fontWeight: '400', fontSize: 16 },
              headerTitle: 'Ajustes',
              headerBackTitle: '',
              animation: 'slide_from_bottom',
            }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const gestureRootStyle = { flex: 1 };
