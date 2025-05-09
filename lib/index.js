const { Connector } = require('../src/deepjson-connector');

module.exports = {
  Connector,
  createConnector: (config) => new Connector(config)
};