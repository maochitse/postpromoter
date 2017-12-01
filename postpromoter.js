var fs = require("fs");
const steem = require('steem');
var utils = require('./utils');

var account = null;
var last_trans = 0;
var outstanding_bids = [];
var config = null;
var start_time = new Date();

steem.api.setOptions({ url: 'https://api.steemit.com' });

console.log("\n *START* \n");

startProcess();

function startProcess() {
  // Load the settings from the config file each time so we can pick up any changes
  config = JSON.parse(fs.readFileSync("config.json"));

  steem.api.getAccounts([config.account], function(err, result) {
    account = result[0];
  });

  if(account) {
    getTransactions();

    // Load the current voting power of the account
    var vp = utils.getVotingPower(account);

    // We are at 100% voting power - time to vote!
    if(vp >= 10000 && outstanding_bids.length > 0) {
      // Make a copy of the list of outstanding bids and vote on them
      startVoting(outstanding_bids.slice());

      // Reset the list of outstanding bids for the next round
      outstanding_bids = [];
    }
  }

  setTimeout(startProcess, 5000);
}

function startVoting(bids) {
  // Sum the amounts of all of the bids
  var total = bids.reduce(function(total, bid) { return total + bid.amount; }, 0);
  console.log('\n=======================================================');
  console.log('Bidding Round End! Starting to vote! Total bids: $' + total);
  console.log('=======================================================\n');

  for(var i = 0; i < bids.length; i++) {
    // Calculate the vote weight to be used for each bid based on the amount bid as a percentage of the total bids
    bids[i].weight = Math.round(config.batch_vote_weight * 100 * (bids[i].amount / total));
  }

  vote(bids);
}

function vote(bids) {
  // Get the first bid in the list
  var bid = bids.pop();
  console.log('Bid Weight: ' + bid.weight);
  steem.broadcast.vote(config.posting_key, account.name, bid.post.author, bid.post.permlink, bid.weight, function(err, result) {
    if (!err && result) {
      console.log(utils.format(bid.weight / 100) + '% vote cast for: @' + bid.post.author + '/' + bid.post.permlink);

      // If promotion content is specified in the config then use it to comment on the upvoted post
      if (config.promotion_content && config.promotion_content != '') {
        // Generate the comment permlink via steemit standard convention
        var permlink = 're-' + bid.post.author.replace(/\./g, '') + '-' + bid.post.permlink + '-' + new Date().toISOString().replace(/-|:|\./g, '').toLowerCase();

        // Replace variables in the promotion content
        var content = config.promotion_content.replace(/\{weight\}/g, utils.format(bid.weight / 100)).replace(/\{sender\}/g, bid.sender);

        // Broadcast the comment
        steem.broadcast.comment(config.posting_key, bid.post.author, bid.post.permlink, account.name, permlink, permlink, content, '', function (err, result) {
          if (err)
            console.log(err, result);
        });
      }
    } else
      console.log(err, result);
  });

  // If there are more bids, vote on the next one after 20 seconds
  if(bids.length > 0)
    setTimeout(function() { vote(bids); }, 30000);
}

function getTransactions() {
  steem.api.getAccountHistory(account.name, -1, 50, function (err, result) {
    result.forEach(function(trans) {
      var op = trans[1].op;
      var ts = new Date((trans[1].timestamp) + 'Z');

        // Check that this is a new transaction that we haven't processed already
        if(ts > start_time && trans[0] > last_trans) {

          // We only care about SBD transfers to the bot
          if (op[0] == 'transfer' && op[1].to == account.name) {
            var amount = parseFloat(op[1].amount);
            var currency = utils.getCurrency(op[1].amount);
            console.log("\nIncoming Bid! From: " + op[1].from + ", Amount: " + op[1].amount + ", memo: " + op[1].memo);

            // Check for min and max bid values in configuration settings
            var min_bid = config.min_bid ? parseFloat(config.min_bid) : 0;
            var max_bid = config.max_bid ? parseFloat(config.max_bid) : 9999;

            if(config.disabled_mode) {
              // Bot is disabled, refund all Bids
              refund(op[1].from, amount, currency, 'Bot is disabled!');
            } else if(amount < min_bid) {
              // Bid amount is too low
              refund(op[1].from, amount, currency, 'Min bid amount is ' + config.min_bid);
            } else if (amount > max_bid) {
              // Bid amount is too high
              refund(op[1].from, amount, currency, 'Max bid amount is ' + config.max_bid);
            } else if(currency != 'SBD') {
              // Sent STEEM instead of SBD
              refund(op[1].from, amount, currency, 'Only SBD bids accepted!');
            } else {
              // Bid amount is just right!
              checkPost(op[1].memo, amount, op[1].from);
            }
          }

          // Save the ID of the last transaction that was processed.
          last_trans = trans[0];
        }
    });
  });
}

function checkPost(memo, amount, sender) {
    // Parse the author and permlink from the memo URL
    var permLink = memo.substr(memo.lastIndexOf('/') + 1);
    var author = memo.substring(memo.lastIndexOf('@') + 1, memo.lastIndexOf('/'));

    // Make sure the author isn't on the blacklist!
    if(config.blacklist && config.blacklist.indexOf(author) >= 0)
    {
      console.log('Invalid Bid - @' + author + ' is on the blacklist!');
      return;
    }

    steem.api.getContent(author, permLink, function (err, result) {
        if (!err && result && result.id > 0) {

            // If comments are not allowed then we need to first check if the post is a comment
            if(!config.allow_comments && (result.parent_author != null && result.parent_author != '')) {
              refund(sender, amount, 'SBD', 'Bids not allowed on comments.');
              return;
            }

            var created = new Date(result.created + 'Z');

            // Get the list of votes on this post to make sure the bot didn't already vote on it (you'd be surprised how often people double-submit!)
            var votes = result.active_votes.filter(function(vote) { return vote.voter == account.name; });
            var already_voted = votes.length > 0 && (new Date() - new Date(votes[0].time + 'Z') > 20 * 60 * 1000);

            if(already_voted || (new Date() - created) >= (config.max_post_age * 60 * 60 * 1000)) {
                // This post is already voted on by this bot or the post is too old to be voted on
                refund(sender, amount, 'SBD', (already_voted ? 'Already Voted' : 'Post older than max age'));
                return;
            }
        } else {
            // Invalid memo
            refund(sender, amount, 'SBD', 'Invalid Memo');
            return;
        }

        // All good - push to the array of valid bids for this round
        console.log('Valid Bid - Amount: ' + amount + ', Title: ' + result.title);
        outstanding_bids.push({ amount: amount, sender: sender, post: result });
    });
}

function refund(sender, amount, currency, reason) {
  // Make sure refunds are enabled and the sender isn't on the no-refund list (for exchanges and things like that).
  if(!config.refunds_enabled || (config.no_refund && config.no_refund.indexOf(sender) >= 0)) {
    console.log("Invalid bid - " + reason + ' NO REFUND');
    return;
  }

  // Issue the refund.
  steem.broadcast.transfer(config.active_key, config.account, sender, utils.format(amount, 3) + ' ' + currency, 'Refund for invalid bid - ' + reason, function(err, response) {
    if(err)
      console.log(err, response);
    else {
      console.log('Refund of ' + amount + ' ' + currency + ' sent to @' + sender + ' for reason: ' + reason);
    }
  });
}
