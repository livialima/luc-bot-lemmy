import { format, getWeekOfMonth } from 'date-fns';
import { stripIndents } from 'common-tags';
import LemmyBot from 'lemmy-bot';
import chalk from 'chalk';
import sqlite3 from 'sqlite3';
import 'dotenv/config';

console.log(`${chalk.magenta('STARTED:')} Started Bot`)

// -----------------------------------------------------------------------------
// Databases

const postdb = new sqlite3.Database('luc.sqlite3', (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Connected to the database.');

    postdb.run(`CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY,
        feature_type TEXT,
        days_left INTEGER
    )`, (err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('Loaded posts table');
    });

    postdb.run(`CREATE TABLE IF NOT EXISTS time (
        key TEXT PRIMARY KEY,
        value INTEGER
    )`, (err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('Loaded time table');

        postdb.run(`INSERT OR IGNORE INTO time (key, value) VALUES ('day', 0)`, (err) => {
            if (err) {
                return console.error(err.message);
            }
        });
    });
});

// -----------------------------------------------------------------------------
// Data

const communities = [
    {
        slug: 'linuxupskillchallenge',
        short: 'Linux Upskill Challenge',
        instance: 'programming.dev',
        categories: [
            'monthly_post',
        ]
    },
]

const posts = [
    {
        name: 'Test Post',
        body: stripIndents`
            This is a test post
            `,
        category: 'monthly_post',
        cron: '0 19 ? * MON#2',
        pin: true,
        pin_length: 1,
        pin_check: 'Test Post'
    },
]

// -----------------------------------------------------------------------------
// Main Bot Code

// Create the list of communities the bot will be interacting in
const allowList = []

for (const community of communities) {
    const allowListEntry = allowList.find((item) => item.instance == community.instance)

    if (allowListEntry) {
        allowListEntry.communities.push(community.slug)
    }
    else {
        allowList.push({
            instance: community.instance,
            communities: [community.slug]
        })
    }
}


// Create the scheduled posts
const scheduledPosts = []

for (const post of posts) {
    scheduledPosts.push({
        cronExpression: post.cron,
        timezone: 'America/Toronto',
        doTask: async ({getCommunityId, createPost}) => {
            for (const community of communities) {
                if (community.categories.includes(post.category)) {
                    const communityId = await getCommunityId({ name: community.slug, instance: community.instance })
                    const postname = post.name.replace('%{WEEKLYDATE}', format(new Date(), 'MMM \'week %{WN},\' yyyy').replace('%{WN}', getWeekOfMonth(new Date()))).replace('%{COMSHORT}', community.short);
                    const postbody = post.body.replace('%{COMSHORT}', community.short);
                    await createPost({ name: postname, body: postbody, community_id: communityId})
                    console.log(`${chalk.blue('POSTED:')} Created ${postname} for ${community.slug}`);
                }
            }
        },
    })
}


// Bot Creation
const bot = new LemmyBot.LemmyBot({
    instance: process.env.INSTANCE,
    credentials: {
        username: process.env.USERNAME,
        password: process.env.PASSWORD,
    },
    dbFile: 'db.sqlite3',
    federation: {
        allowList: allowList,
    },
    handlers: {
        post: {
            handle: async ({
                postView: {
                    post,
                    creator
                },
                botActions: { featurePost },
            }) => {
                // Pin post if its by the bot and set to be pinned
                if (creator.name == process.env.USERNAME && posts.find((item) => item.pin && post.name.startsWith(item.pin_check))) {
                    await featurePost({postId: post.id, featureType: "Community", featured: true})
                    console.log(`${chalk.green('FEATURED:')} Featured ${post.name} in ${post.community_id} by ${creator.name}`)

                    // Add to db
                    postdb.run(`INSERT INTO posts (id, days_left) VALUES (${post.id}, ${posts.find((item) => item.pin && post.name.startsWith(item.pin_check)).pin_length})`, (err) => {
                        if (err) {
                            return console.error(err.message);
                        }
                    });
                }
            }
        }
    },
    schedule: [...scheduledPosts, {
        cronExpression: '0 */5 * * * *',
        timezone: 'America/Toronto',
        doTask: async ({ featurePost }) => {
            const now = addMinutes(new Date(), 30);
            const day = now.getDay();

            postdb.get(`SELECT value FROM time WHERE key = 'day'`, (err, row) => {
                if (err) {
                    return console.error(err.message);
                }

                if (row.value !== day) {
                    postdb.run(`UPDATE time SET value = ${day} WHERE key = 'day'`, (err) => {
                        if (err) {
                            return console.error(err.message);
                        }
                    });

                    console.log(`${chalk.magenta('TIME:')} Updated day to ${day}`);
                    // decrement all post times by 1
                    postdb.run(`UPDATE posts SET days_left = days_left - 1`, (err) => {
                        if (err) {
                            return console.error(err.message);
                        }

                        console.log(`${chalk.magenta('TIME:')} Decremented all post times`);

                        // get all posts with 0 days left and unpin them
                        postdb.all(`SELECT * FROM posts WHERE days_left = 0`, async (err, rows) => {
                            if (err) {
                                return console.error(err.message);
                            }

                            for (const row of rows) {
                                await featurePost({postId: row.post_id, featureType: "Community", featured: false})
                                console.log(`${chalk.green('UNFEATURED:')} Unfeatured ${row.post_id} in ${row.community_id}`);
                            }

                            // delete all posts with 0 days left
                            postdb.run(`DELETE FROM posts WHERE days_left = 0`, (err) => {
                                if (err) {
                                    return console.error(err.message);
                                }

                                console.log(`${chalk.magenta('TIME:')} Deleted all posts with 0 days left`);
                            });
                        });
                    });
                }
            });
        }
    }]
});

bot.start();