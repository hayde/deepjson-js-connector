const { Connector } = require('../dist/deepjson-connector');

module.exports = {
  Connector,
  createConnector: (config) => new Connector(config)
};