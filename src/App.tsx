import React, { useEffect } from 'react';
import { StatusBar } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { LanguagePairScreen } from './screens/LanguagePairScreen';
import { ConversationScreen } from './screens/ConversationScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { audioCaptureService } from './services/audio/AudioCaptureService';
import { nativeTTSService } from './services/tts/NativeTTSService';
import { initNetworkMonitor, disposeNetworkMonitor } from './services/network/monitor';
import { createMistralProbe } from './services/network/mistralProbe';
import { loadMistralApiKey, saveMistralApiKey } from './services/storage/secureStorage';
import { useSettingsStore } from './store/settingsStore';
import type { RootStackParamList } from './navigation/types';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App(): React.JSX.Element {
  const languagePairConfigured = useSettingsStore(s => s.languagePairConfigured);

  useEffect(() => {
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
    <GestureHandlerRootView style={gestureRootStyle}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <NavigationContainer>
          <Stack.Navigator
            initialRouteName={languagePairConfigured ? 'Conversation' : 'LanguagePair'}
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: '#000' },
              animation: 'fade',
            }}>
            <Stack.Screen name="LanguagePair" component={LanguagePairScreen} />
            <Stack.Screen name="Conversation" component={ConversationScreen} />
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              options={{
                headerShown: true,
                headerStyle: { backgroundColor: '#000' },
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
