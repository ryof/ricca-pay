'use strict';
import config from 'config';
import bwclient from 'bitcore-wallet-client';
import request from 'sync-request';
import botkit from 'botkit';
import mysql from 'mysql';
import moment from 'moment';
function getRateJPY() {
  const rate_api_url = 'https://coincheck.com/api/exchange/orders/rate?order_type=buy&pair=btc_jpy&amount=1';
  let response = request('GET', rate_api_url);
  let rate;
  if (response.statusCode == 200) {
    rate = Math.round(JSON.parse(response.body).rate);
    return rate;
  }
}
function jpy2btc(jpyAmount) {
  let rate = getRateJPY();
  return jpyAmount * 1.0 / rate;
}
function inBTC(satoshi) {
  return (satoshi / 100000000.0).toFixed(3);
}
function inSatoshi(btc) {
  return parseFloat((btc * 100000000).toFixed(0));
}
function saveWallet(userId, passphrase) {
  connection.query('INSERT INTO account SET ?',
    {
      slack_id: userId,
      passphrase: passphrase,
      role: 'user'
    },
    (err, results, fields) => {
      if (err) {
        throw new Error(err);
      }
    }
  );
}
function activateWallet(userId, passphrase) {
  let client = new bwclient(config.bwc);
  client.importFromMnemonic(passphrase, {network: 'testnet'}, err => {
    if (err) {
      throw new Error(err);
    }
  });
  client.openWallet((err, ret) => {
    if (err) {
      throw new Error(err);
    }
    if (ret.wallet.status == 'complete') {
      userBWClients[userId] = client;
    }
  });
}
function transfer(btc, item, creditorId, debtorId) {
  let creditorClient = userBWClients[creditorId];
  let debtorClient = userBWClients[debtorId];
  creditorClient.createAddress({ignoreMaxGap: true}, function(err, addr) {
    if (err) {throw new Error(err);}
    console.log(addr);
    let txp = {}
    txp.outputs = [{
      'toAddress': addr.address,
      'amount': inSatoshi(btc),
      'message': item
    }];
    txp.message = item;
    debtorClient.createTxProposal(txp, function(err, createdTxp) {
      if (err) {throw new Error(err);}
      console.log('tx created.');
      debtorClient.publishTxProposal({txp: createdTxp}, function(err, publishedTxp) {
        if (err) {throw new Error(err);}
        console.log('tx published.');
        debtorClient.signTxProposal(publishedTxp, '', function(err, signedTxp) {
          if (err) {throw new Error(err);}
          console.log('tx signed.');
          debtorClient.broadcastTxProposal(signedTxp, function(err, broadcastedTxp, memo) {
            if (err) {throw new Error(err);}
            console.log('tx broadcasted!!!');
          });
        });
      });
    });
  });
}
function ts2datetime(ts) {
  let datetime = moment.unix(Math.floor(ts).toString()).format('YYYY-MM-DD HH:mm:ss');
  let microsec = ts.split('.')[1];
  return `${datetime}.${microsec}`;
}
const userIdPattern = /<@([A-Z\d]+)>/;
const userBWClients = {};
const adminPassword = config.adminPassword;
let connection = mysql.createConnection(config.db);
if (
  !process.env.token ||
  !process.env.clientId ||
  !process.env.clientSecret
) {
  console.error('token/clientId/clientSecret should be specified');
  process.exit(1);
}
connection.connect(err => {
  if (err) {
    throw new Error(err);
  }
});
connection.query('SELECT slack_id, passphrase FROM account', (err, results, fields) => {
  if (err) {
    throw new Error(err);
  }
  results.forEach(result => {
    activateWallet(result.slack_id, result.passphrase);
  });
});
let controller = botkit.slackbot({
  debug: false
}).configureSlackApp(
  {
    clientId: process.env.clientId,
    clientSecret: process.env.clientSecret,
    scopes: ['bot']
  }
);
controller.spawn({
  token: process.env.token
}).startRTM(err => {
  if (err) {
    throw new Error(err);
  }
});
controller.hears(`^charge ((${userIdPattern.source} )+)(.+) (\\d+)$`, ['direct_mention'], (bot, message) => {
  let userIds = message.match[1].slice(0, -1).split(' ').map(e => e.match(/[A-Z\d]+/)[0]);
  let item = message.match[4];
  let dutch = Math.round(message.match[5] / (userIds.length + 1.00));
  console.log(message);
  if (userIds.every(e => e in userBWClients)) {
    bot.say(
      {
        text: `${userIds.map(function(e){return `<@${e}>`;}).join(' and ')} can you accept this charge from <@${message.user}>?`,
        channel: message.channel
      },
      (err, response) => {
        if (err) {
          throw new Error(err);
        }
        let chargeTs = response.ts;
        bot.api.reactions.add({
          timestamp: chargeTs,
          channel: response.channel,
          name: 'ok'
        });
        bot.api.reactions.add({
          timestamp: chargeTs,
          channel: response.channel,
          name: 'ng'
        });
        connection.beginTransaction(err => {
          if (err) {
            throw new Error(err);
          }
          let creditorId = message.user;
          userIds.forEach(debtorId => {
            connection.query(
              'INSERT INTO debt SET ?',
              {
                ts: ts2datetime(chargeTs),
                debtor_id: debtorId,
                creditor_id: creditorId,
                item: item,
                amount: dutch,
                key_currency: 'JPY',
                status: 'claimed'
              },
              (err, result) => {
                if (err) {
                  connection.rollback();
                  throw new Error(err);
                }
                connection.commit(err => {
                  if (err) {
                    connection.rollback();
                    throw new Error(err);
                  }
                });
              }
            );
          });
        });
      }
    );
  } else {
    bot.reply(message, 'you specified someone who has not opened a wallet.');
  }
});
controller.hears('^credit$', ['direct_mention'], (bot, message) => {
  let userId = message.user;
  if (userId in userBWClients) {
    connection.query(
      'SELECT debtor_id, item, amount FROM debt WHERE status = \'claimed\' AND creditor_id = ?',
      [userId],
      (err, results, fields) => {
        if (err) {
          throw new Error(err);
        }
        if (results.length > 0) {
          let credits = results.map(result => {
            return [`<@${result.debtor_id}>`, result.item, `${result.amount}JPY`].join('\t');
          });
          bot.reply(message, 'you have credits below! :moneybag: \n```' + credits.join('\n') + '\n```');
        } else {
          bot.reply(message, 'you have no credits :white_check_mark:');
        }
      }
    );
  } else {
    bot.say('you\'ve not activated a wallet');
  }
});
controller.hears('^debt$', ['direct_mention'], (bot, message) => {
  let userId = message.user;
  if (userId in userBWClients) {
    connection.query(
      'SELECT creditor_id, item, amount FROM debt WHERE status = \'claimed\' AND debtor_id = ?',
      [userId],
      (err, results, fields) => {
        if (err) {
          throw new Error(err);
        }
        if (results.length > 0) {
          let credits = results.map(result => [`<@${result.creditor_id}>`, result.item, `${result.amount}JPY`].join('\t'));
          bot.reply(message, 'you have debts below.. :money_with_wings: \n```' + credits.join('\n') + '\n```');
        } else {
          bot.reply(message, 'you have no debts! :ok_hand:');
        }
      }
    );
  } else {
    bot.say('you\'ve not activated a wallet');
  }
});
controller.hears(`^balance ${userIdPattern.source}$`, ['direct_mention'], (bot, message) => {
  let userId = message.match[1];
  if (userId in userBWClients) {
    let client = userBWClients[userId];
    client.getBalance((err, x) => {
      if (err) {
        throw new Error(err);
      }
      bot.reply(message, `<@${userId}> has ${inBTC(x.totalAmount)}BTC!`);
    });
  } else {
    bot.say('the user has not activated a wallet');
  }
});
controller.hears('^help$', ['direct_mention', 'direct_message'], (bot, message) => {
  let usage = `
  \`\`\`
  # charge users PRICE for ITEM
  - @ricca.pay charge [@user1 @user2 ...] ITEM PRICE
  # show your credits
  - @ricca.pay credit
  # show your debts
  - @ricca.pay debt
  # show balance of a user
  - @ricca.pay balance @user
  # show this usage
  - @ricca.pay help
  # show current rate for BTC/JPY
  - @ricca.pay rate
  # activate your wallet for the first time (thru DM)
  - activate
  # deactivate your wallet (thru DM)
  - deactivate
  \`\`\`
  `;
  bot.reply(message, usage);
});
controller.hears('^rate$', ['direct_mention'], (bot, message) => {
  let rate = getRateJPY();
  if (rate) {
    bot.reply(message, `1BTC is now worth ${rate}JPY!`);
  } else {
    bot.reply(message, 'cannot get the rate somehow :pensive:');
  }
});
controller.hears('^activate$', ['direct_message'], (bot, message) => {
  if (message.user in userBWClients) {
    bot.reply(message, 'you\'ve already activated your wallet!');
    return false;
  }
  bot.startConversation(message, (err, convo) => {
    convo.ask(
      'can you tell me the passphrase of your wallet? (12 words)',
      [
        {
          pattern: /^([a-z]+ ){11}[a-z]+$/,
          callback: (response, convo) => {
            let passphrase = response.text.split(/[\u3000\s]+/).join(' ');
            saveWallet(message.user, passphrase);
            activateWallet(message.user, passphrase);
            convo.next();
          }
        },
        {
          default: true,
          callback: (response, convo) => {
            convo.stop('this doesn\'t seem to be a passphrase!');
          }
        }
      ]
    );
    convo.say('activation finished!');
  });
});
controller.hears('^deactivate$', ['direct_message'], (bot, message) => {
  if (message.user in userBWClients) {
    delete userBWClients[message.user];
    //TODO delete from DB
    bot.reply(message, 'your wallet is deactivated!');
  } else {
    bot.reply(message, 'you have no wallet to deactivate!');
    //TODO print usage of activation
  }
});
controller.hears(`adminize ${adminPassword}$`, ['direct_message'], (bot, message) => {
  connection.query(
    'UPDATE account SET role = \'admin\' WHERE slack_id = ?',
    [message.user],
    (err, results, fields) => {
      if (err) {
        throw new Error(err);
      }
    }
  );
  bot.reply('you\'re an administrator from now on!');
});
controller.hears(['ありがと', '有り?難', 'thx', '[Tt]hank'], ['direct_message', 'direct_mention'], (bot, message) => {
  bot.reply(message, 'You\'re welcome :blush:');
});
controller.on('direct_mention', (bot, message) => {
  bot.reply(message, 'what?');
});
controller.on('direct_message', (bot, message) => {
  bot.reply(message, 'what? what did you say?');
});
controller.on('reaction_added', (bot, event) => {
  console.log(event);
  if (event.reaction == 'ok' || event.reaction == 'ng') {
    let ts = event.item.ts;
    let userReacting = event.user;
    let newStatus;
    switch (event.reaction) {
    case 'ok':
      newStatus = 'approved';
      break;
    case 'ng':
      newStatus = 'rejected';
      break;
    default:
      break;
    }
    connection.query('UPDATE debt SET status = ? WHERE ts = ? AND debtor_id = ?', [newStatus, ts2datetime(ts), userReacting], (err, results, fields) => {
      if (err) {throw new Error(err);}
    });
    connection.query('SELECT creditor_id, debtor_id, item, amount, status FROM debt WHERE ts = ?', [ts2datetime(ts)], (err, results, fields) => {
      if (err) {throw new Error(err);}
      let isRejectedBySomeone = results.map(e => e.status == 'rejected').reduce((pv, cv, i, a) => pv || cv, false);
      if (isRejectedBySomeone) {
        // unable to post with `bot.say(text)` when in controller.on?
        bot.say(
          {
            text: `<@${results[0].creditor_id}> your claim on ${results[0].item} was rejected! :disappointed:`,
            channel: event.item.channel
          }
        );
      } else {
        let isApprovedByAll = results.map(e => e.status == 'approved').reduce((pv, cv, i, a) => pv && cv, true);
        if (isApprovedByAll) {
          bot.say(
            {
              text: `<@${results[0].creditor_id}> your claim on ${results[0].item} was approved by all debtors! :smile:\ntransfer ${results[0].amount} JPY from debtors each :money_with_wings:`,
              channel: event.item.channel
            }
          );
          results.forEach(result => {
            transfer(jpy2btc(result.amount), result.item, result.creditor_id, result.debtor_id);
          });
        }
      }
    });
  }
});
