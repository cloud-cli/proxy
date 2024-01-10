import config from '@cloud-cli/jest-config';

export default {
  ...config,
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  coverageThreshold: {},
};
