import React, { useEffect } from 'react';
import { StatusBar } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SetupScreen } from './screens/SetupScreen';
import { ConversationScreen } from './screens/ConversationScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { initModels } from './services/models/ModelManager';
import { warmupTranslation } from './services/pipeline/PipelineOrchestrator';
import { nativeTTSService } from './services/tts/NativeTTSService';
import { memoryMonitor } from './services/memory/MemoryMonitor';
import { useModelStore } from './store/modelStore';
import type { RootStackParamList } from './navigation/types';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App(): React.JSX.Element {
  useEffect(() => {
    // Init OS TTS early so it's warm when needed
    void nativeTTSService.init();

    // Start model loading in background — ConversationScreen shows progress
    void initModels()
      .then(() => void warmupTranslation().catch(() => {}))
      .catch(err => {
        console.error('[App] Model init failed:', err);
        useModelStore.getState().setWhisperError(
          err instanceof Error ? err.message : String(err),
        );
      });

    // Memory pressure monitoring
    memoryMonitor.start(15_000);
    return () => memoryMonitor.stop();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0f0f0f" />
      <NavigationContainer>
        <Stack.Navigator
          initialRouteName="Setup"
          screenOptions={{
            headerStyle: { backgroundColor: '#111827' },
            headerTintColor: '#f9fafb',
            headerTitleStyle: { fontWeight: '700' },
            contentStyle: { backgroundColor: '#0f0f0f' },
            animation: 'slide_from_right',
          }}>
          <Stack.Screen
            name="Setup"
            component={SetupScreen}
            options={{ title: 'Parly' }}
          />
          <Stack.Screen
            name="Conversation"
            component={ConversationScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ title: 'Ajustes' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
