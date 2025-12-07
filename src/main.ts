import { Devvit, TriggerContext, SettingScope, ModeratorPermission, Post, Comment } from '@devvit/public-api';

// Configure the app to use Reddit API
Devvit.configure({ redditAPI: true });

const enum Status {
  Active = 'Active', //set in global secrets for status
  Paused = 'Paused', //set in global secrets for status
  Blocked = 'Blocked', //
  Secret_Blocked = 'Secret Blocked',
  Update_Available = 'Update Available', //set latest version in global secrets for status
  Update_Required = 'Update Required', //set latest required version in global secrets for status
  Disabled = 'Disabled',
  Failing = 'Failing', //set in global secrets for status
}

const HIGHLIGHT_FEED_SUB = "highlights";
const CROSSPOSTED_KEY_PREFIX = 'crossposted:';
async function seenPost (context: TriggerContext, postId: string): Promise<boolean> {
  const v = await context.redis.get(CROSSPOSTED_KEY_PREFIX + postId);
  return v !== undefined && v !== null;
}

async function storePost (context: TriggerContext, postId: string, ttlSeconds = 24*3600) {
  const ttlSecondsSetting = await context.settings.get('postIdTimeout') as number;
  if(ttlSecondsSetting) {
    ttlSeconds = ttlSecondsSetting;
  }
  console.log('ttlSeconds: ' + ttlSeconds);
  console.log('ttlSecondsSetting: ' + ttlSecondsSetting);
  await context.redis.set(CROSSPOSTED_KEY_PREFIX + postId, '1', {expiration: new Date(Date.now() + ttlSeconds * 1000)});
}

// Add the trigger for mod actions
Devvit.addTrigger({
  event: 'ModAction',
  async onEvent(event, context) {
    if(!await context.settings.get('enableCrossposting') as boolean) {
      //if sub disabled crossposting, don't do anything
      return;
    }
    // Log the event to see its structure
    //console.log('ModAction event received:', JSON.stringify(event, null, 2));

    const subredditName = await context.reddit.getCurrentSubredditName();
    if(subredditName === HIGHLIGHT_FEED_SUB) {
      //ignore actions in the highlight feed subreddit itself
      return;
    }
    if((await getBlockedCommunities(context)).includes(subredditName)) {
      console.log('Skipping highlight since ' + subredditName + ' is a blocked community');
      return;
    }
    if((await getSecretBlockedCommunities(context)).includes(subredditName)) {
      console.log('Skipping highlight since ' + subredditName + ' is a secret blocked community');
      return;
    }
    if((await getBlockedAuthors(context)).includes(await context.reddit.getCurrentUsername() || '')) {
      console.log('Skipping highlight since ' + await context.reddit.getCurrentUsername()  + ' is a blocked author');
      return;
    }
    const matchedKeywords = await findBlockedKeywords(context, event.targetPost);
    if(matchedKeywords.length > 0) {
      console.log('Skipping highlight since source post ' + event.targetPost?.id  + ' conains blocked keywords in the title or body: ', matchedKeywords);
      return;
    }

    const stickyAction = event.targetPost?.id && (event.action?.toLowerCase() === 'sticky' 
                        || event.action?.toLowerCase() === 'highlight_post' 
                        || event.action?.toLowerCase() === 'highlight');
    const unstickyAction = !stickyAction && event.targetPost?.id && (event.action?.toLowerCase() === 'unsticky'
                        || event.action?.toLowerCase() === 'unhighlight_post' 
                        || event.action?.toLowerCase().includes('unhighlight')
                        || event.action?.toLowerCase().includes('remove_highlight'));

    // Check if this is a sticky/highlight action
    if ((stickyAction || unstickyAction) && event.targetPost) {
      try {
        const postId = event.targetPost.id;
        console.log('------------------------------------------------------------------------');
        console.log(event.action + " event for post ID " + postId);
        console.log('------------------------------------------------------------------------');

        if(unstickyAction) {
          // Add to recently processed
          console.log('Post ' + postId + ' was unstickied. Storing so it doesn\'t count as a new highlight if added back or being reordered');
          await storePost(context, postId);
          return;
        }

        const clearCacheOnSubreddit = await context.settings.get('clearCacheForPostId') as string;
        if(clearCacheOnSubreddit) {
          if(clearCacheOnSubreddit.includes(":")) {
            console.log('######### Clear Cache Initiated #########');
            let [clearSub, clearPostId] = clearCacheOnSubreddit.split(':').map(s => s.trim());
            if(clearSub.includes('r/')) {
              clearSub = clearSub.split('r/')[1];
            }
            if(postId.startsWith('t3_') && !clearPostId.startsWith('t3_')) {
              clearPostId = 't3_' + clearPostId;
            }
            const cacheCleared = await context.redis.get('cacheCleared');
            if(clearSub === context.subredditName && clearPostId === postId && !cacheCleared) {
              await context.redis.del(CROSSPOSTED_KEY_PREFIX + postId);
              await context.redis.set('cacheCleared', 'true');
              console.log(`Cache cleared on r/${clearSub} for postId ${clearPostId}`);
            }
          }
          else {
            console.log('######### Clear Cache Process Reset #########');
            await context.redis.del('cacheCleared');
          }
        }

        // Check if we just processed this post
        if (await seenPost(context, postId)) {
            console.log('Already handled this sticky event recently:', postId);
            return;
        }
        
        // Add to recently processed
        await storePost(context, postId);

        const nsfw = event.subreddit?.nsfw ? '[NSFW] ' : '';
        // Submit the crosspost to the target subreddit
        const crosspost = await context.reddit.crosspost({
          title: "Highlighted post from " + nsfw + "r/" + subredditName,
          subredditName: HIGHLIGHT_FEED_SUB,
          postId: event.targetPost.id,
          sendreplies: false,
          nsfw: event.targetPost.nsfw,
          spoiler: event.targetPost.isSpoiler
        });
        console.log('Crossposted highlighted post ID:', postId);
        
        //set the category flair if set for the original subreddit
        const categoryFlair = await context.settings.get('category') as string;
        console.log('Category flair to set:', categoryFlair);
        if (categoryFlair && categoryFlair.length > 0) {
          try {
            await context.reddit.setPostFlair({subredditName: HIGHLIGHT_FEED_SUB, postId: crosspost.id, flairTemplateId: categoryFlair[0]});
            console.log('Set flair for crossposted highlighted post:', categoryFlair[0]);
          } catch (flairError) {
            console.error('Error setting flair ' + categoryFlair[0] + ' for crossposted highlighted post: ' + crosspost.id, flairError);
          }
        }

        //leave a sticky comment to explain the crosspost
        const comment = await crosspost.addComment({text: "[To see the source post, click the crosspost above or this link](" + event.targetPost.url + ")", runAs: "APP"});
        try{
          await comment.distinguish(true); // the boolean here is whether to sticky it
        }
        catch(error) {
          console.error('Error stickying reminder comment ' + comment.id + ' on post ' + crosspost.id, error);
        }

        //lock the post, as it's just a pointer to the original
        await crosspost.lock();
      } catch (error) {
        console.error('Error handling sticky/highlight', error);
      }

      if((await context.settings.get('leaveCommentOnSourcePost')) as boolean) {
        let stickySourceComment = (await context.settings.get('stickyCommentOnSourcePost')) as boolean;
        if(stickySourceComment) {
          stickySourceComment = !postHasStickyComment(context, event.targetPost.id);
        }
        //leave a comment on the source post to let users know about r/highlights
        const sourceComment = await context.reddit.submitComment({id: event.targetPost.id, text: "This post was highlighted by mods and automatically crossposted to r/highlights. Check it out to see a feed of highlighted posts!", runAs: "APP"});
        try{
          await sourceComment.distinguish(stickySourceComment); // the boolean here is whether to sticky it
        }
        catch(error) {
          console.error('Error stickying r/highlights comment ' + sourceComment.id + ' on post ' + event.targetPost.id, error);
        }
        try{
          await sourceComment.lock();
        }
        catch(error) {
          console.error('Error locking r/highlights comment ' + sourceComment.id + ' on post ' + event.targetPost.id, error);
        }
      }

      console.log('');
    }
  }
});

/**
 * Determines whether a post should be cross-posted based on override rules.
 * Returns false if the post is blocked, true if it can be posted.
 */
async function shouldCrosspostHighlight(
    post: { author: { username: string }, subreddit: string, postType: string, title: string, body?: string },
    context: any
): Promise<boolean> {
    // 1. Blocked Communities
    const blockedCommunities: string[] = JSON.parse(await context.settings.get('blockedCommunities') ?? '[]');
    if (blockedCommunities.includes(post.subreddit)) {
        console.log(`Blocked subreddit: ${post.subreddit}`);
        return false;
    }

    // 2. Blocked Authors
    const blockedAuthors: string[] = JSON.parse(await context.settings.get('blockedAuthors') ?? '[]');
    if (blockedAuthors.includes(post.author.username)) {
        console.log(`Blocked author: ${post.author.username}`);
        return false;
    }

    // 3. Allowed Post Types
    const allowedTypes: string[] = JSON.parse(await context.settings.get('allowedPostTypes') ?? '["link","image","self"]');
    if (!allowedTypes.includes(post.postType)) {
        console.log(`Disallowed post type: ${post.postType}`);
        return false;
    }

    // 4. Blocked Keywords
    const blockedKeywords: string[] = JSON.parse(await context.settings.get('blockedKeywords') ?? '[]');
    if (blockedKeywords.some(word =>
        post.title.toLowerCase().includes(word.toLowerCase()) ||
        (post.body && post.body.toLowerCase().includes(word.toLowerCase()))
    )) {
        console.log(`Post contains blocked keyword`);
        return false;
    }
    // 5. Daily Highlights Limit
    const todayKey = new Date().toISOString().split('T')[0]; // e.g., "2025-11-14"
    const countKey = `highlightCount:${post.subreddit}:${todayKey}`;
    const currentCount = parseInt(await context.redis.get(countKey) ?? '0');
    const MAX_HIGHLIGHTS_PER_DAY = parseInt(await context.settings.get('maxHighlightsPerDay') ?? '10');
    if (currentCount >= MAX_HIGHLIGHTS_PER_DAY) {
        console.log(`Daily highlight limit reached for ${post.subreddit}`);
        return false;
    }

    // Increment the count if the post passes all filters
    await context.redis.incr(countKey);

    // 6. Logging for transparency
    console.log(`Post from ${post.subreddit} by ${post.author.username} cleared for crosspost`);

    return true;
}

async function postHasStickyComment(context: Devvit.Context | TriggerContext, postId: string): Promise<boolean> {
  const topLevelComments = await context.reddit.getComments({
    postId,
    depth: 1,     // <— prevents fetching replies
    limit: 1000
  }).all();

  return topLevelComments.some(c => c.isStickied());
}

Devvit.addSettings([
  {
    type: 'boolean',
    name: 'enableCrossposting',
    defaultValue: true,
    label: 'Enable to cross-posts highlights, disable to stop cross-posting if needed',
    scope: SettingScope.Installation,
  },
  {
    type: 'select',
    name: 'category',
    label: 'Community Category',
    helpText: 'Category used for flairing in the highlight subreddit. Crossposts won\'t be flaired or filterable without this set',
    options: [
      // General / Social / Meta / Humor
      { label: 'Discussion & Advice', value: '8116d2b0-c104-11f0-ba03-cac7875e7d8e' },
      { label: 'Help & Resources', value: '812f6f00-c104-11f0-a695-d61073cd9d3e' },
      { label: 'Humor', value: '8165541c-c104-11f0-b84c-16436baf855e' },
      { label: 'Reddit Meta', value: '81787a92-c104-11f0-8d58-c2d1810b4928' },

      // Entertainment & Pop Culture
      { label: 'Movies & TV', value: '818b2dc2-c104-11f0-9d21-a20953174c75' },
      { label: 'Music', value: '819e8d2c-c104-11f0-b7ee-063ed85649f2' },
      { label: 'Pop Culture', value: '81b1c126-c104-11f0-934c-6e7350573ad8' },
      { label: 'AMAs & Stories', value: '81c54dae-c104-11f0-b085-225e95d64023' },

      // Creative & Fandom
      { label: 'Art & Design', value: '81d839c8-c104-11f0-80ed-8ee400c453d8' },
      { label: 'Crafts', value: '81e919dc-c104-11f0-8599-0e0ad5eb106b' },
      { label: 'Fandom', value: '81fb3072-c104-11f0-8d44-6a98ab5ec58f' },
      { label: 'Reading & Writing', value: '8212309c-c104-11f0-8f59-b250e05eb494' },

      // Internet & Gaming
      { label: 'Internet Culture', value: '82252f80-c104-11f0-a264-2a1937a740e9' },
      { label: 'Memes', value: '82387aa4-c104-11f0-9545-dabf32d9d372' },
      { label: 'Games', value: '824dceea-c104-11f0-9ac2-766240be57db' },
      { label: 'Technology', value: '82625e50-c104-11f0-8239-36f556121843' },

      // Academic & Knowledge
      { label: 'Sciences', value: '8274ecbe-c104-11f0-a11c-cad03ca4a796' },
      { label: 'Humanities & Law', value: '82868a50-c104-11f0-8008-6e7a248e7f30' },
      { label: 'Education & Career', value: '829a8690-c104-11f0-8bcb-e69e882f9efe' },

      // Lifestyle & Daily Living
      { label: 'Fashion & Beauty', value: '82aeaa4e-c104-11f0-b208-f26e4a77128e' },
      { label: 'Wellness', value: '82c0f55a-c104-11f0-b46a-7ac3440c4681' },
      { label: 'Food & Drinks', value: '82d3b398-c104-11f0-8486-5654d9796f25' },

      // Outdoors, Nature, Animals
      { label: 'Nature & Outdoors', value: '82e54130-c104-11f0-85dd-a6a988a5634d' },
      { label: 'Animals & Pets', value: '82f8fe82-c104-11f0-942a-3284563714c9' },
      { label: 'Horror & Paranormal', value: '8311f4aa-c104-11f0-aca3-2ebd92d39a7d' },

      // Practical & Home
      { label: 'Home & Garden', value: '83248a3e-c104-11f0-b50d-12872b60ab1e' },
      { label: 'DIY & Home Improvement', value: '833a2f7e-c104-11f0-be21-1e5f316cc316' },

      // Hobbies & Collecting
      { label: 'General Hobbies', value: '834d7188-c104-11f0-bfa3-5e4a00749add' },
      { label: 'Collectibles', value: '8360d354-c104-11f0-9ec9-36f556121843' },

      // Business & Career
      { label: 'Business & Finance', value: '8373ad4e-c104-11f0-b72f-d61073cd9d3e' },

      // News & Politics
      { label: 'News & Politics', value: '8385d4ec-c104-11f0-81b6-3e8d7f975dc3' },

      // Vehicles
      { label: 'Vehicles', value: '8398359c-c104-11f0-8b31-9a2b757ddab7' },

      // Sports
      { label: 'Sports', value: '83ab2a94-c104-11f0-9dec-b2dab2b6ab43' },
    ],
    scope: SettingScope.Installation,
    multiSelect: false,
  },
  {
    type: 'boolean',
    name: 'leaveCommentOnSourcePost',
    defaultValue: true,
    label: 'Leave Comment on Source Post',
    helpText: 'Leave a comment on the source post, so viewers know about r/highlights feed',
    scope: SettingScope.Installation,
  },
  {
    type: 'boolean',
    name: 'stickyCommentOnSourcePost',
    defaultValue: true,
    label: 'Sticky Comment on Source Post',
    helpText: 'If leaving a comment on the source post, sticky it (unless there\'s already a sticky comment there)',
    scope: SettingScope.Installation,
  },
  // Global secret
  {
    type: 'number',
    name: 'postIdTimeout',
    label: 'Post ID Timeout (seconds)',
    defaultValue: 24 * 3600, //one day
    scope: SettingScope.App,
  },
  // Global secret
  {
    type: 'string',
    name: 'clearCacheForPostId',
    label: 'subreddit_name:post_id_to_clear',
    defaultValue: '',
    scope: SettingScope.App,
    isSecret: true,
  },
  // Global secret
  {
    type: 'string',
    name: 'appStatus',
    label: 'Displays in the Highlight Feed Status form (accepts ' + Status.Active + ', '+ Status.Paused + ', '+ Status.Disabled,
    defaultValue: Status.Active,
    scope: SettingScope.App,
    isSecret: true,
  },
  // Global secret
  {
    type: 'string',
    name: 'recommendAppVersion',
    label: 'Latest version of this app recommended (CLI: ... set recommendAppVersion "1.0.2"',
    defaultValue: '',
    scope: SettingScope.App,
    isSecret: true,
  },
  // Global secret
  {
    type: 'string',
    name: 'requiredAppVersion',
    label: 'Latest version of this app required (CLI: ... set requiredAppVersion "1.0.2"',
    defaultValue: '',
    scope: SettingScope.App,
    isSecret: true,
  },
  // Global secret
  {
    name: 'blockedCommunities',
    type: 'string',
    label: 'Blocked Communities (CLI: ... set blockedCommunities "[\"sub1\",\"sub2\"]")',
    scope: SettingScope.App,
    defaultValue: '[]',
    isSecret: true,
  },
  // Global secret
  {
    name: 'secretBlockedCommunities',
    type: 'string',
    label: 'Secret Blocked Communities (CLI: ... set blockedCommunities "[\"sub1\",\"sub2\"]")',
    defaultValue: '[]',
    scope: SettingScope.App,
    isSecret: true,
  },
  // Global secret
  {
    name: 'blockedAuthors',
    type: 'string',
    label: 'Blocked Keywords (CLI: ["keyword", "/pattern/i"])',
    defaultValue: '[]',
    scope: SettingScope.App,
    isSecret: true,
  },
  // Global secret
  {
    name: 'blockedKeywords',
    type: 'string',
    label: 'Blocked Keywords (CLI: ... set blockedKeywords "[\"keyword1\",\"keyword2\"]")',
    defaultValue: '[]',
    scope: SettingScope.App,
    isSecret: true,
  },
  // Number
  {
    name: 'maxHighlightsPerDay',
    type: 'number',
    label: 'Max Highlights Per Day (CLI: ... set maxHighlightsPerDay 10)',
    scope: SettingScope.App,
    defaultValue: 10,
  },
  // Global secret (stringified JSON)
  {
    name: 'maxHighlightsPerDayPerSub',
    type: 'string',
    label: 'Max Highlights Per Day Per Sub (CLI: ... set maxHighlightsPerDayPerSub \'{"subredditA":3,"subredditB":5}\')',
    defaultValue: '',
    scope: SettingScope.App,
    isSecret: true,
  },
]);

Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (event, context) => {
    // Send a modmail reminder to select a category for highlight crossposts
    await context.reddit.modMail.createModNotification({
          subredditId: context.subredditId,
          subject: 'Please remember to select a category flair for r/highlights crossposts',
          bodyMarkdown: "This app will automatically crosspost highlighted posts to r/highlights. " + 
                        "However, those crossposts won't have a category flair for filtering until one is assigned in the settings page:\n\n"
                        + "https://developers.reddit.com/r/" + context.subredditName + "/apps/" + context.appName,
      })
  },
});

/** Returns app status as a string */
async function getAppStatus(context: Devvit.Context | TriggerContext): Promise<string> {
  return (await context.settings.get('appStatus')) as string;
}

/** Returns recommended update version as a string */
async function getRecommendedUpdateVersion(context: Devvit.Context): Promise<string> {
  return (await context.settings.get('recommendAppVersion')) as string;
}

/** Returns required update version as a string */
async function getRequiredUpdateVersion(context: Devvit.Context | TriggerContext): Promise<string> {
  return (await context.settings.get('requiredAppVersion')) as string;
}

/** Returns blocked communities as a string array */
async function getBlockedCommunities(context: Devvit.Context | TriggerContext): Promise<string[]> {
  const blockedStr = (await context.settings.get('blockedCommunities')) as string;
  try {
    return JSON.parse(blockedStr) || [];
  } catch {
    return [];
  }
}

/** Returns secret blocked communities as a string array */
async function getSecretBlockedCommunities(context: Devvit.Context | TriggerContext): Promise<string[]> {
  const blockedStr = (await context.settings.get('secretBlockedCommunities')) as string;
  try {
    return JSON.parse(blockedStr) || [];
  } catch {
    return [];
  }
}

/** Returns blocked authors as a string array */
async function getBlockedAuthors(context: Devvit.Context | TriggerContext): Promise<string[]> {
  const blockedStr = (await context.settings.get('blockedAuthors')) as string;
  try {
    return JSON.parse(blockedStr) || [];
  } catch {
    return [];
  }
}

/** Returns blocked keywords as a string array */
async function getBlockedKeywords(context: Devvit.Context | TriggerContext): Promise<string[]> {
  const blockedStr = (await context.settings.get('blockedKeywords')) as string;
  try {
    return JSON.parse(blockedStr) || [];
  } catch {
    return [];
  }
}

/**
 * Returns list of matching blocked keywords (supports regex)
 */
export async function findBlockedKeywords(
  context: Devvit.Context | TriggerContext,
  post: any
): Promise<string[]> {
  const rawKeywords = await getBlockedKeywords(context);
  if (!rawKeywords || rawKeywords.length === 0) return [];

  const normalizedKeywords = rawKeywords
    .map(normalizeKeyword)
    .filter(k => k.length > 0);

  const combined = extractPostText(post);

  const matches: string[] = [];

  for (const keyword of normalizedKeywords) {
    let regex: RegExp;

    if (keyword.startsWith('/') && keyword.endsWith('/') && keyword.length > 2) {
      // It's regex; strip slashes
      const pattern = keyword.slice(1, -1);
      try {
        regex = new RegExp(pattern, 'i');
      } catch {
        console.warn(`Invalid regex blockedKeyword: ${keyword}`);
        continue;
      }
    } else {
      // Literal
      regex = new RegExp(escapeRegex(keyword), 'i');
    }

    if (regex.test(combined)) {
      matches.push(keyword);
    }
  }

  return matches;
}

/** Returns max highlights per day as a number */
async function getMaxHighlightsPerDay(context: Devvit.Context | TriggerContext): Promise<number> {
  const value = await context.settings.get('maxHighlightsPerDay');
  return typeof value === 'number' ? value : 10; // fallback to default
}

/** Returns max highlights per day per sub as an object mapping subreddit to number */
async function getMaxHighlightsPerDayPerSub(context: Devvit.Context | TriggerContext): Promise<Record<string, number>> {
  const valueStr = (await context.settings.get('maxHighlightsPerDayPerSub')) as string;
  try {
    return valueStr ? JSON.parse(valueStr) : {};
  } catch {
    return {};
  }
}

/**
 * Highlight Feed Status
 */
Devvit.addMenuItem({
    label: "Highlight Feed Status",
    location: "subreddit",
    forUserType: "moderator",
    onPress: async (event, context) => {
      const crosspostingEnabled = await context.settings.get('enableCrossposting') as boolean;
      let status = await getAppStatus(context);

      const blockedSubs = await getBlockedCommunities(context);
      const isBlocked = blockedSubs.includes(context.subredditId);

      const updateRecommendedVersion = await getRecommendedUpdateVersion(context);
      const updateRequiredVersion = await getRequiredUpdateVersion(context);
      const recommendUpdateAvailable = await isNewerVersionAvailable(updateRecommendedVersion, context);
      const requiredUpdateAvailable = await isNewerVersionAvailable(updateRequiredVersion, context);

      if(isBlocked) {
        status = Status.Blocked;
      }
      else if(requiredUpdateAvailable) {
        status = Status.Update_Required;
      }
      else if(recommendUpdateAvailable) {
        status = Status.Update_Available;
      }

      const fullPermModOnHighlightsSub = await checkForModPerms(context, ['all']) && context.subredditName === HIGHLIGHT_FEED_SUB;

      const fields: any[] = [];
      if (!fullPermModOnHighlightsSub) {
        fields.push({
          name: 'crosspostingEnabled',
          label: 'Automatic Crossposting Enabled',
          helpText: 'This can be controlled in the app settings',
          type: 'boolean',
          defaultValue: crosspostingEnabled,
          disabled: true,
        });
        fields.push({
          name: 'appStatus',
          label: 'App Status',
          helpText: 'Current global app status',
          type: 'string',
          defaultValue: status,
          disabled: true,
        });
      }
      else { //fullPermModOnHighlightsSub
        //
        // STATUS
        //
        fields.push({
          name: 'appStatus',
          label: 'App Status',
          options: [
            { label: formatStatus(Status.Active), value: Status.Active },
            { label: formatStatus(Status.Paused), value: Status.Paused },
            { label: formatStatus(Status.Disabled), value: Status.Disabled },
            { label: formatStatus(Status.Failing), value: Status.Failing },
          ],
          helpText: 'Current global app status',
          type: 'select',
          defaultValue: [formatStatus(status)],
          disabled: false,
        });

        //
        // VERSION FIELDS
        //
        fields.push({
          name: 'recommendedUpdateVersion',
          label: 'Recommended Update Version',
          helpText: 'Displayed to recommend updating to this version',
          type: 'string',
          defaultValue: updateRecommendedVersion,
          disabled: false,
        });

        fields.push({
          name: 'requiredUpdateVersion',
          label: 'Required Update Version',
          helpText: 'Displayed to require updating to this version',
          type: 'string',
          defaultValue: updateRequiredVersion,
          disabled: false,
        });

        //
        // BLOCKED SUBREDDITS (PUBLIC BLOCK)
        //
        fields.push({
          name: 'blockedSubreddits',
          label: 'Blocked Subreddits',
          helpText:
            'Comma-separated list of subs blocked from crossposting highlights. (Example: funny, pics, gaming)',
          type: 'string',
          defaultValue: (await getBlockedCommunities(context)).join(', '),
          disabled: false,
        });

        //
        // SECRET BLOCKED SUBREDDITS (PRIVATE BLOCK)
        //
        fields.push({
          name: 'secretBlockedSubreddits',
          label: 'Secret Blocked Subreddits',
          helpText:
            'Comma-separated subs blocked silently (no notice sent). (Example: askreddit, videos)',
          type: 'string',
          defaultValue: (await getSecretBlockedCommunities(context)).join(', '),
          disabled: false,
        });

        //
        // BLOCKED AUTHORS
        //
        fields.push({
          name: 'blockedAuthors',
          label: 'Blocked Authors',
          helpText:
            'Comma-separated list of authors to skip. Add u/ or not—either is fine. (Example: spez, kn0thing)',
          type: 'string',
          defaultValue: (await getBlockedAuthors(context)).join(', '),
          disabled: false,
        });

        //
        // BLOCKED KEYWORDS
        //
        fields.push({
          name: 'blockedKeywords',
          label: 'Blocked Keywords',
          helpText: 'Comma-separated keywords or regex. CLI requires: ["word","/regex/i"]',
          type: 'string',
          defaultValue: (await getBlockedKeywords(context)).join(', '),
          disabled: false,
        });

        //
        // MAX HIGHLIGHTS PER DAY (GLOBAL NUMBER)
        //
        fields.push({
          name: 'maxHighlightsPerDay',
          label: 'Global Max Highlights Per Day',
          helpText: 'Number of highlights allowed per day across ALL source subs.',
          type: 'number',
          defaultValue: await getMaxHighlightsPerDay(context),
          disabled: false,
        });

        //
        // MAX PER-SUB MAP (STRING INPUT)
        //
        fields.push({
          name: 'maxHighlightsPerDayPerSub',
          label: 'Max Highlights Per Day Per Sub',
          helpText:
            'Comma-separated list of per-sub limits: "sub=value". Example: funny=3, pics=1, gaming=2',
          type: 'string', // IMPORTANT: not number
          defaultValue: Object.entries(await getMaxHighlightsPerDayPerSub(context))
            .map(([sub, value]) => `${sub}=${value}`)
            .join(', '),
          disabled: false,
        });
      }
      context.ui.showForm(statusForm, {fields, fullPermModOnHighlightsSub});
    }
});

/**
 * Highlight Feed Status
 */
const statusForm = Devvit.createForm(
  (data) => ({
    fields: data.fields,
    title: 'Highlight Feed Status',
    description: data.fullPermModOnHighlightsSub ? 'Edit desired settings here and click Generate to be given CLI command(s) that can perform the updates' : '',
    acceptLabel: data.fullPermModOnHighlightsSub ? 'Generate' : "Close",
    cancelLabel: "Cancel",
  }),
  async ({ values }, context) => {
    try {
        const fullPermModOnHighlightsSub = await checkForModPerms(context, ['all']) && context.subredditName === HIGHLIGHT_FEED_SUB;
        if(!fullPermModOnHighlightsSub) {
          return;
        }
        const cliCommands: string[] = [];
        const prefix = "devvit secrets:set global"; // Adjust if needed

        //
        // 1. App Status (string)
        //
        const currentStatus = (await getAppStatus(context)).toLowerCase().trim();
        const newStatus = values.appStatus[0].toLowerCase().trim();
        if (currentStatus !== newStatus) {
          cliCommands.push(`${prefix} appStatus "${newStatus}"`);
        }

        //
        // 2. Recommended Update Version
        //
        const currentRecommended = (await getRecommendedUpdateVersion(context)).trim();
        const newRecommended = values.recommendedUpdateVersion.trim();
        if (currentRecommended.toLowerCase() !== newRecommended.toLowerCase()) {
          cliCommands.push(`${prefix} recommendedUpdateVersion "${newRecommended}"`);
        }

        //
        // 3. Required Update Version
        //
        const currentRequired = (await getRequiredUpdateVersion(context)).trim();
        const newRequired = values.requiredUpdateVersion.trim();
        if (currentRequired.toLowerCase() !== newRequired.toLowerCase()) {
          cliCommands.push(`${prefix} requiredUpdateVersion "${newRequired}"`);
        }

        //
        // 4. Blocked Communities (array of strings)
        //
        const currentCommunities = (await getBlockedCommunities(context)).map(normalizeSubreddit);
        const newCommunities = parseList(values.blockedSubreddits).map(normalizeSubreddit);
        if (!listsEqual(currentCommunities, newCommunities)) {
          cliCommands.push(`${prefix} blockedCommunities "${JSON.stringify(newCommunities)}"`);
        }

        //
        // 5. Blocked Authors
        //
        const currentAuthors = (await getBlockedAuthors(context)).map(normalizeAuthor);
        const newAuthors = parseList(values.blockedAuthors).map(normalizeAuthor);
        if (!listsEqual(currentAuthors, newAuthors)) {
          cliCommands.push(`${prefix} blockedAuthors "${JSON.stringify(newAuthors)}"`);
        }

        //
        // 6. Blocked Keywords
        //
        const currentKeywords = (await getBlockedKeywords(context)).map(normalizeKeyword);
        const newKeywords = parseList(values.blockedKeywords).map(normalizeKeyword);
        if (!listsEqual(currentKeywords, newKeywords)) {
          cliCommands.push(`${prefix} blockedKeywords "${JSON.stringify(newKeywords)}"`);
        }

        //
        // 7. Max Highlights Per Day (number)
        //
        const currentMax = await getMaxHighlightsPerDay(context);
        const newMax = Number(values.maxHighlightsPerDay);
        if (currentMax !== newMax) {
          cliCommands.push(`${prefix} maxHighlightsPerDay "${newMax}"`);
        }

        //
        // 8. Max Highlights Per Day Per Sub (map)
        //
        const currentMap = await getMaxHighlightsPerDayPerSub(context);  // Record<string, number>
        const newMap = parseMaxPerSubField(values.maxHighlightsPerDayPerSub); // { sub: number }

        if (!mapsEqual(currentMap, newMap)) {
          cliCommands.push(`${prefix} maxHighlightsPerDayPerSub '${JSON.stringify(newMap)}'`);
        }

        // Print all CLI commands to use
        console.log('CLI commands needed to update settings:');
        cliCommands.forEach(c => console.log(c));

    }
    catch(error) {
        console.error('Error displaying :', error, '\nCaller stack:\n', new Error().stack?.split('\n').slice(1,5).join('\n'));
        context.ui.showToast('Error displaying user breakdown\n(' + error + ')');
        throw error;
    }
  }
);

function normalizeSubreddit(raw: string): string {
  return raw
    .trim()
    .replace(/^\/?r\//i, "") // remove /r/ or r/
    .replace(/\/+/g, "")     // remove double slashes
    .toLowerCase();
}

function normalizeAuthor(raw: string): string {
  return raw
    .trim()
    .replace(/^\/?u\//i, "") // remove /u/ or u/
    .replace(/\/+/g, "")
    .toLowerCase();
}

/**
 * Escape a string so it is treated as literal text inside a regex.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeKeyword(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Safely extract title + body regardless of Devvit Post version.
 */
function extractPostText(post: any): string {
  const title = (post.title ?? '').toLowerCase();

  // Devvit sometimes uses selftext, sometimes selfText
  const body =
    (post.selftext ??
     post.selfText ??
     post.self_text ??
     '').toLowerCase();

  return `${title} ${body}`;
}

function mapsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();

  if (aKeys.length !== bKeys.length) return false;

  for (const k of aKeys) {
    if (b[k] !== a[k]) return false;
  }

  return true;
}

async function appendMaxPerSubCLICommand(
  cliCommands: string[],
  values: any,
  context: any,
  cliCommandPrefix: string
) {
  const current = await getMaxHighlightsPerDayPerSub(context);    // Record<string, number>
  const requested = parseMaxPerSubField(values.maxHighlightsPerDayPerSub);

  if (!mapsEqual(current, requested)) {
    const jsonValue = JSON.stringify(requested);
    cliCommands.push(`${cliCommandPrefix} set maxHighlightsPerDayPerSub '${jsonValue}'`);
  }
}

function parseList(input: string): string[] {
  if (!input || !input.trim()) return [];
  return input
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function parseMaxPerSubField(input: string): Record<string, number> {
  if (!input || !input.trim()) return {};

  const map: Record<string, number> = {};

  input.split(",").forEach(entry => {
    const [rawKey, rawValue] = entry.split("=").map(p => p.trim());
    if (!rawKey || !rawValue) return;

    const sub = normalizeSubreddit(rawKey);
    const value = Number(rawValue);

    if (!isNaN(value)) {
      map[sub] = value;
    }
  });

  return map;
}

function listsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function formatStatus(status: string): string {
  switch(status) {
    case Status.Active: return '🟢 ' + status;
    case Status.Paused: return'🟡 ' + status;
    case Status.Blocked: return'⛔️ ' + status;
    case Status.Update_Available: return'⚠️ ' + status;
    case Status.Update_Required: return'⛔️ ' + status;
    case Status.Disabled: return'⚪️ ' + status;
    case Status.Failing: return'🔴 ' + status;
  }
  return status;
}

/**
 * Compare app versions to see if a newer version is available.
 * @param newVersion - Version string to compare against (e.g., "1.2.3")
 * @param context - Devvit context to access app info
 * @returns true if the current app version is lower than newVersion
 */
async function isNewerVersionAvailable(newVersion: string, context: Devvit.Context | TriggerContext): Promise<boolean> {
  // Get the current app version from the manifest
  const currentVersion = context.appVersion; // e.g., "1.2.0"

  const parseVersion = (v: string) => v.split('.').map(Number);

  const [currMajor, currMinor, currPatch] = parseVersion(currentVersion);
  const [newMajor, newMinor, newPatch] = parseVersion(newVersion);

  if (newMajor > currMajor) return true;
  if (newMajor === currMajor && newMinor > currMinor) return true;
  if (newMajor === currMajor && newMinor === currMinor && newPatch > currPatch) return true;

  return false; // current version is equal or newer
}

// Devvit.addMenuItem({
//   label: 'Temp Post Flair Creation Handler',
//   description: "Adjust your settings (doesn't affect other mods)",
//   location: "subreddit",
//   forUserType: "moderator",
//   onPress: async (_, context) => {
//     if(await context.reddit.getCurrentUsername() !== "MajorParadox" && context.subredditName === 'highlights') {
//       context.ui.showToast('This is a temp feature, not accessible by others yet');
//       return;
//     }
//     const flairNames = [
//      '',...
//     ] as Array<string>;
//     for(let i = 0; i < flairNames.length; i++) {
//       const flairName = flairNames[i];
//       await context.reddit.createPostFlairTemplate({
//         'subredditName': context.subredditName || '',
//         'allowableContent': 'all',
//         'backgroundColor': 'transparent',
//         'maxEmojis': 1,
//         'modOnly': false,
//         'text': flairName,
//         'textColor': 'dark',
//         'allowUserEdits': false,
//       });
//     }
//   }
// });

/*Devvit.addMenuItem({
  label: 'Temp Post Flair Reorder Handler',
  location: "subreddit",
  forUserType: "moderator",
  onPress: async (_, context) => {
    if(await context.reddit.getCurrentUsername() !== "MajorParadox" && context.subredditName === 'highlights') {
      context.ui.showToast('This is a temp feature, not accessible by others yet');
      return;
    }
    await reorderFlairs(context);
  }
});*/

/**
 * TEMP FUNCTION: Reorder all subreddit post flairs to match a fixed order.
 * Call this once manually from a mod action or button.
 */
/*async function reorderFlairs(context: Devvit.Context) {
  const newOrder = [
    // General / Social / Meta / Humor
    'Discussion & Advice',
    'Help & Resources',
    'Humor',
    'Reddit Meta',

    // Entertainment & Pop Culture
    'Movies & TV',
    'Music',
    'Pop Culture',
    'AMAs & Stories',

    // Creative & Fandom
    'Art & Design',
    'Crafts',
    'Fandom',
    'Reading & Writing',

    // Internet & Gaming
    'Internet Culture',
    'Memes',
    'Games',
    'Technology',

    // Academic & Knowledge
    'Sciences',
    'Humanities & Law',
    'Education & Career',

    // Lifestyle & Daily Living
    'Fashion & Beauty',
    'Wellness',
    'Food & Drinks',
    'Communities & Identity',

    // Outdoors, Nature, Animals
    'Nature & Outdoors',
    'Animals & Pets',
    'Horror & Paranormal',

    // Practical & Home
    'Home & Garden',
    'DIY & Home Improvement',

    // Hobbies & Collecting
    'General Hobbies',
    'Collectibles',

    // Business & Career
    'Business & Finance',

    // News & Politics
    'News & Politics',

    // Vehicles
    'Vehicles',

    // Sports (usually last in interest sections)
    'Sports',
  ];

  const subreddit = context.subredditName!;
  const api = context.reddit;

  // Get existing flairs
  const flairs = await api.getPostFlairTemplates(subreddit);

  // Reorder the flairs by matching text to newOrder
  const sorted = newOrder
    .map(text => flairs.find(f => f.text === text))
    .filter(Boolean);

  // Delete all existing flair templates
  for (const flair of flairs) {
    await api.deleteFlairTemplate(subreddit, flair.id);
  }

  const recreated: { text: string; id: string }[] = [];

  // Recreate flairs in the new order
  for (const flair of sorted) {
    const created = await api.createPostFlairTemplate({'subredditName': subreddit,
      'text': flair?.text || '',
      'backgroundColor': flair?.backgroundColor,
      'textColor': flair?.textColor,
      'modOnly': flair?.modOnly,
      'allowUserEdits': flair?.allowUserEdits,
    });

    // Devvit returns the templateId in "id"
    recreated.push({ text: flair?.text || '', id: created.id });
  }

  // Print all recreated IDs to the console
  console.log("Reordered Flair Templates:");
  for (const f of recreated) {
    console.log(`- ${f.text}: ${f.id}`);
  }
}*/

/**
 * Check mod permissions
 */
export async function getModPerms(context: Devvit.Context) : Promise<ModeratorPermission[]> {
    const subredditName = await context.reddit.getCurrentSubredditName() || '';
    const username = await context.reddit.getCurrentUsername() || '';
    const listing = context.reddit.getModerators({ subredditName });
    const mods = await listing.all(); // <-- convert Listing<User> to User[]
    const mod = mods.find(m => m.username.toLowerCase() === username.toLowerCase());
    const perms = mod ? await mod.getModPermissionsForSubreddit(subredditName) : [];
    return perms;
}

export async function checkForModPerms(context: Devvit.Context, requiredPerms : ModeratorPermission[]) : Promise<boolean> {
    const perms = await getModPerms(context);
    // If the user has "all", they automatically pass.
    if (perms.includes('all')) return true;

    // Otherwise, check if every required permission is present.
    return requiredPerms.every(p => perms.includes(p));
}

// Export the configured Devvit instance
export default Devvit;