/* eslint-env jest */
// Global mocks for native modules so component-tree tests (App.test.tsx) can
// mount the real navigator + screens. Service unit tests inject their own
// collaborators and are unaffected by these.

import 'react-native-gesture-handler/jestSetup';

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

jest.mock('react-native-safe-area-context', () => {
  const inset = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  const React = require('react');
  return {
    SafeAreaProvider: ({ children }) => children,
    SafeAreaView: ({ children }) => children,
    SafeAreaInsetsContext: React.createContext(inset),
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { insets: inset, frame },
  };
});

jest.mock('@react-native-masked-view/masked-view', () => {
  const React = require('react');
  const { View } = require('react-native');
  // The real component is a native ViewGroup; for the tree test all that
  // matters is that children still render.
  const MaskedView = ({ children, style }) => React.createElement(View, { style }, children);
  return { __esModule: true, default: MaskedView };
});

jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const LinearGradient = props => React.createElement(View, props, props.children);
  return { __esModule: true, default: LinearGradient };
});

jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const stub = () => props => React.createElement(View, null, props?.children);
  return {
    __esModule: true,
    default: stub(),
    Svg: stub(),
    Circle: stub(),
    Ellipse: stub(),
    Rect: stub(),
    Path: stub(),
    G: stub(),
    Defs: stub(),
    Mask: stub(),
    Stop: stub(),
    RadialGradient: stub(),
    LinearGradient: stub(),
  };
});

jest.mock('react-native-keychain', () => ({
  getGenericPassword: jest.fn().mockResolvedValue(false),
  setGenericPassword: jest.fn().mockResolvedValue(true),
  resetGenericPassword: jest.fn().mockResolvedValue(true),
}));

jest.mock('react-native-tts', () => ({
  __esModule: true,
  default: {
    getInitStatus: jest.fn().mockResolvedValue('success'),
    voices: jest.fn().mockResolvedValue([]),
    setDefaultRate: jest.fn(),
    setDefaultVoice: jest.fn().mockResolvedValue(undefined),
    setDefaultLanguage: jest.fn().mockResolvedValue(undefined),
    speak: jest.fn().mockResolvedValue('utterance-1'),
    stop: jest.fn(),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

jest.mock('react-native-audio-record', () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    start: jest.fn(),
    stop: jest.fn().mockResolvedValue(''),
    on: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

jest.mock('onnxruntime-react-native', () => ({
  InferenceSession: { create: jest.fn() },
  Tensor: jest.fn(),
}));
