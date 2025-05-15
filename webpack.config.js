const path = require('path');

module.exports = {
  entry: './src/deepjson-connector.js',
  mode: 'production',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'deepjson-connector.min.js',
    library: {
        name: 'DeepJsonConnector',
        type: 'umd',
      },
    libraryTarget: 'umd',
    globalObject: 'this'
  },
  target: ['web', 'es5'],
  externals: {
    'socket.io-client': 'io',
    axios: 'axios',
    'form-data': 'FormData'
  }
};