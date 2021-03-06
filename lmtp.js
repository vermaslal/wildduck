'use strict';

const config = require('config');
const log = require('npmlog');
const SMTPServer = require('smtp-server').SMTPServer;
const mongodb = require('mongodb');
const MongoClient = mongodb.MongoClient;
const crypto = require('crypto');
const tools = require('./lib/tools');
const MessageHandler = require('./lib/message-handler');

let messageHandler;
let database;

const server = new SMTPServer({

    // log to console
    logger: {
        info(...args) {
            args.shift();
            log.info('LMTP', ...args);
        },
        debug(...args) {
            args.shift();
            log.silly('LMTP', ...args);
        },
        error(...args) {
            args.shift();
            log.error('LMTP', ...args);
        }
    },

    name: false,
    lmtp: true,

    // not required but nice-to-have
    banner: 'Welcome to Wild Duck Mail Agent',

    // disable STARTTLS to allow authentication in clear text mode
    disabledCommands: ['AUTH', 'STARTTLS'],

    // Accept messages up to 10 MB
    size: config.lmtp.maxMB * 1024 * 1024,

    // Validate RCPT TO envelope address. Example allows all addresses that do not start with 'deny'
    // If this method is not set, all addresses are allowed
    onRcptTo(rcpt, session, callback) {
        let originalRecipient = tools.normalizeAddress(rcpt.address);
        let recipient = originalRecipient.replace(/\+[^@]*@/, '@');

        if (session.users && session.users.has(recipient)) {
            return callback();
        }

        database.collection('addresses').findOne({
            address: recipient
        }, (err, address) => {
            if (err) {
                log.error('SMTP', err);
                return callback(new Error('Database error'));
            }
            if (!address) {
                return callback(new Error('Unknown recipient'));
            }

            if (!session.users) {
                session.users = new Map();
            }

            session.users.set(recipient, {
                recipient: originalRecipient,
                user: address.user
            });

            callback();
        });
    },

    // Handle message stream
    onData(stream, session, callback) {
        let chunks = [];
        let chunklen = 0;
        let hash = crypto.createHash('md5');
        stream.on('readable', () => {
            let chunk;
            while ((chunk = stream.read()) !== null) {
                chunks.push(chunk);
                chunklen += chunk.length;
                hash.update(chunk);
            }
        });

        stream.once('error', err => {
            log.error('LMTP', err);
            callback(new Error('Error reading from stream'));
        });

        stream.once('end', () => {
            let err;
            if (stream.sizeExceeded) {
                err = new Error('Error: message exceeds fixed maximum message size ' + config.lmtp.maxMB + ' MB');
                err.responseCode = 552;
                return callback(err);
            }

            if (!session.users || !session.users.size) {
                return callback(new Error('Nowhere to save the mail to'));
            }

            let users = Array.from(session.users);
            let stored = 0;
            let storeNext = () => {
                if (stored >= users.length) {
                    return callback(null, 'Message queued as ' + hash.digest('hex').toUpperCase());
                }

                let recipient = users[stored][0];
                let rcptData = users[stored][1] || {};
                stored++;

                // add Delivered-To
                let header = Buffer.from('Delivered-To: ' + recipient + '\r\n');
                chunks.unshift(header);
                chunklen += header.length;

                messageHandler.add({
                    user: rcptData.user,
                    path: 'INBOX',
                    meta: {
                        source: 'LMTP',
                        from: tools.normalizeAddress(session.envelope.mailFrom && session.envelope.mailFrom.address || ''),
                        to: rcptData.recipient,
                        origin: session.remoteAddress,
                        originhost: session.clientHostname,
                        transhost: session.hostNameAppearsAs,
                        transtype: session.transmissionType,
                        time: Date.now()
                    },
                    date: false,
                    flags: false,
                    raw: Buffer.concat(chunks, chunklen)
                }, err => {
                    // remove Delivered-To
                    chunks.shift();
                    chunklen -= header.length;

                    if (err) {
                        log.error('LMTP', err);
                    }

                    storeNext();
                });
            };

            storeNext();
        });
    }
});

module.exports = done => {
    if (!config.lmtp.enabled) {
        return setImmediate(() => done(null, false));
    }
    MongoClient.connect(config.mongo, (err, mongo) => {
        if (err) {
            log.error('LMTP', 'Could not initialize MongoDB: %s', err.message);
            return;
        }
        database = mongo;
        messageHandler = new MessageHandler(database);

        let started = false;

        server.on('error', err => {
            if (!started) {
                started = true;
                return done(err);
            }
            log.error('LMTP', err);
        });

        server.listen(config.lmtp.port, config.lmtp.host, () => {
            if (started) {
                return server.close();
            }
            started = true;
            done(null, server);
        });
    });
};
