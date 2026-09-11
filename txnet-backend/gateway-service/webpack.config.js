const path = require('path');
const nodeExternals = require('webpack-node-externals');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const { TsconfigPathsPlugin } = require('tsconfig-paths-webpack-plugin');

const isProduction = process.env.NODE_ENV === 'production';

module.exports = {
  mode: isProduction ? 'production' : 'development',
  target: 'node',
  entry: './src/main.ts',
  output: {
    path: path.resolve(__dirname, '../dist/gateway-service'),
    filename: 'main.js',
    clean: false,
  },
  externalsPresets: { node: true },
  // The workspace is a single-package Nx repo: node_modules and package.json
  // live at `txnet-backend/`, but webpack-cli runs with cwd `gateway-service/`.
  // `modulesDir` must therefore be spelled out — with the default (or with
  // `modulesFromFile`, which looks for an `gateway-service/package.json` that
  // does not exist) nothing is externalised and every dependency, express and
  // @nestjs included, gets compiled into the bundle on every build.
  externals: [nodeExternals({ modulesDir: path.resolve(__dirname, '../node_modules') })],
  resolve: {
    extensions: ['.ts', '.js'],
    // Workspace libraries (`@txnet-backend/*`) are tsconfig path aliases, not
    // packages in node_modules. Without this, ts-loader's `transpileOnly`
    // compiles the import happily and webpack emits a "Cannot find module"
    // stub that only fails at runtime — a build that passes and a service
    // that cannot boot.
    plugins: [
      new TsconfigPathsPlugin({
        configFile: path.resolve(__dirname, 'tsconfig.app.json'),
      }),
    ],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            configFile: path.resolve(__dirname, 'tsconfig.app.json'),
            transpileOnly: true,
          },
        },
      },
    ],
  },
  optimization: { minimize: false },
  // A full `source-map` is re-serialised in its entirety on every rebuild;
  // in dev the cheap per-module variant gives the same stack traces for our
  // own .ts files at a fraction of the cost.
  devtool: isProduction ? 'source-map' : 'eval-cheap-module-source-map',
  cache: {
    type: 'filesystem',
    cacheDirectory: path.resolve(__dirname, '../.webpack-cache/gateway-service'),
  },
  // `nx serve` re-runs this build from scratch (one-shot) on every save, so a
  // type-check plugin here can't defer its work to a later tick the way it
  // does under a persistent webpack --watch process — it just blocks the
  // process exit for as long as a full program check takes. Only pay for it
  // on production builds; dev relies on the editor/tsc for type feedback.
  plugins: isProduction
    ? [
        new ForkTsCheckerWebpackPlugin({
          typescript: { configFile: path.resolve(__dirname, 'tsconfig.app.json') },
        }),
      ]
    : [],
};
