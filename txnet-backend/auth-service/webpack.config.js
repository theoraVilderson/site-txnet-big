const path = require('path');
const nodeExternals = require('webpack-node-externals');

module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  target: 'node',
  entry: './src/main.ts',
  output: {
    path: path.resolve(__dirname, '../dist/auth-service'),
    filename: 'main.js',
    clean: false,
  },
  externalsPresets: { node: true },
  externals: [
    ({ request }, callback) => {
      if (request === 'argon2' || request === 'cookie-parser' || request === '@prisma/client') {
        return callback(null, `commonjs ${request}`);
      }
      callback();
    },
    nodeExternals({ modulesFromFile: true }),
    ({ request }, callback) => {
      if (
        request === 'class-validator' ||
        request === 'class-transformer' ||
        request.startsWith('@nestjs/websockets') ||
        request.startsWith('@nestjs/microservices')
      ) {
        return callback(null, `commonjs ${request}`);
      }
      callback();
    },
  ],
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: { configFile: path.resolve(__dirname, 'tsconfig.app.json') },
        },
      },
    ],
  },
  optimization: { minimize: false },
  devtool: 'source-map',
};
