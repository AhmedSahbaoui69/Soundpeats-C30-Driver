'use strict';

// Configuration for the SOUNDPEATS C30.
module.exports = {
  RFCOMM_CHANNEL: 1,
  CONNECTION_TIMEOUT: 8000, // ms
  COMMAND_DELAY: 200, // ms between commands
  DEVICE_NAME_PATTERN: 'soundpeats|c30', // auto-detect by device name
};
