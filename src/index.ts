import { Browser, Page } from 'puppeteer';
const chalk = require('chalk');

require('dotenv').config();
import { usageOptions, cmdOptions } from './cli-config';

const puppeteer = require('puppeteer');
const cmdArgs = require('command-line-args');
const cmdUsage = require('command-line-usage');
const fs = require('fs').promises;
const check = require('fs');

const usage = cmdUsage(usageOptions);
const args = cmdArgs(cmdOptions);

const { timeout, infinity, verbose, help, proxy, file } = args;
const headless = !args['no-headless'];
var game = args['game'];

if (help || !(game || file)) {
	process.exit(0);
}

if (!game) {
	throw new Error('Please, provide a game to start watching!');
}

var spaceRegex = new RegExp('\\s', 'gm');
game = game.replace(spaceRegex, '%20').replace(':', '%3A').toLowerCase();

if (!process.env.TWITCH_CHROME_EXECUTABLE) {
	throw new Error('TWITCH_CHROME_EXECUTABLE not set');
}
if (!process.env.TWITCH_AUTH_TOKEN) {
	throw new Error('TWITCH_AUTH_TOKEN not set');
}

// const directoryUrl = `https://www.twitch.tv/directory/game/${game}?tl=c2542d6d-cd10-4532-919b-3d19f30a768b`; // doesn't work
const directoryUrl = `https://www.twitch.tv/directory/game/${game}`;

function formatLog(msg: string) {
	return `[${new Date().toUTCString()}] ${msg}`;
}

function info(msg: string) {
	console.info(formatLog(msg));
	// TODO: single line console
	// process.stdout.write(formatLog(msg).padEnd(50) + '\x1b[0G');
}

function vinfo(msg: string) {
	if (!verbose) return;
	console.debug(`${chalk.blue('[VERBOSE]')} ${formatLog(msg)}`);
}

function warn(msg: string) {
	console.warn(`${chalk.yellow('[WARNING]')} ${formatLog(msg)}`);
}

async function initTwitch(page: Page) {
	info('Navigating to Twitch');
	await page.goto('https://twitch.tv', {
		waitUntil: ['networkidle2', 'domcontentloaded']
	});
	info('Configuring streaming settings');
	await page.evaluate(() => {
		localStorage.setItem('mature', 'true');
		localStorage.setItem('video-muted', '{"default":true}');
		localStorage.setItem('volume', '0.0');
		localStorage.setItem('video-quality', '{"default":"160p30"}');
	});
	info('Signing in using auth-token');
	await page.setCookie({
		name: 'auth-token',
		value: process.env.TWITCH_AUTH_TOKEN
	});
}

let buffering = 0;
let prevDuration = -1;

let excludedChannels: string[] = [];

async function findRandomChannel(page: Page) {
	// TODO: Need more tests for this new way to verify channels
	await page.goto(directoryUrl, {
		waitUntil: ['networkidle2', 'domcontentloaded']
	});
	// const aHandle = await page.waitForSelector('a[data-a-target="preview-card-image-link"]', {
	// 	timeout: 0
	// });
	// const channel = await page.evaluate((a) => a?.getAttribute('href'), aHandle);
	const channel = await page.$$eval(
		'[data-a-target="preview-card-image-link"]',
		(streams) => streams.map((e) => e.getAttribute('href'))
	);

	info(`${channel.length} channels found: ${channel.join(', ')}`);

	var channelAux = '';

	for (let c of channel) {
		var find = excludedChannels.find((obj) => {
			return obj == c ? true : false;
		});

		if (find) continue;

		info(chalk.green(`Checking ${chalk.yellow.bold(c)}`));
		await page.goto(`https://twitch.tv${c}`, {
			waitUntil: ['networkidle2', 'domcontentloaded']
		});

		if (!(await activeDrops(page))) {
			excludedChannels.push(c ?? '');
		} else {
			channelAux = c ?? '';
			break;
		}
	}
	if (channelAux != '') {
		console.clear();
		info(
			chalk.green(`Active drops for https://www.twitch.tv${chalk.bold(channelAux)}`)
		);
		info(chalk.green(`Watching...`));
	} else {
		if (infinity && channelAux == '') {
			excludedChannels = [];
			info(chalk.yellow(`No channel with drops. Keep searching...`));
			findRandomChannel(page);
		} else {
			info(chalk.green(`No channel with active drops! Exiting...`));
			process.exit(0);
		}
	}
}

let list: string[];

async function readList() {
	info(`Parsing list of channels: ${file}`);
	const read = await fs.readFile(file, { encoding: 'utf-8' });
	list = read.split(/\r?\n/).filter((s: string) => s.length !== 0);
	info(`${list.length} channels found: ${list.join(', ')}`);
}

async function streamingGame(page: Page) {
	const gameLink = await page.waitForSelector('a[data-a-target="stream-game-link"]', {
		timeout: 0
	});

	const href = await page.evaluate((a) => a?.getAttribute('href'), gameLink);

	const streamingGame = href?.toLowerCase().endsWith(`/${game.toLowerCase()}`);

	return streamingGame;
}

async function channelExists(page: Page) {
	// TODO: need more validation
	return (await page.$('p[data-a-target="core-error-message"]')) ? true : false;
}

async function activeDrops(page: Page) {
	// TODO: need more validation

	// = (await page.$('p[class="CoreText-sc-cpl358-0 iiqKwk"]')) ? true : false;

	var activeDrops = (await page.$('.tw-card-image')) ? true : false;
	return activeDrops;

	// const extractedText = await page.$eval('p', (el) => el.outerHTML);

	// const extractedText = await page.$$eval('p', (text) =>
	// 	text.map((e) => e.innerHTML.toLowerCase().includes('drops'))
	// );

	// const extractedText = await page.evaluate(() => window.find('drops'));

	// console.log('🚀 ~ activeDrops ~ extractedText', extractedText);

	// x = extractedText.map((z) => {
	// 	return z.toLocaleLowerCase().includes('drops') ? true : false;
	// });

	// for (let z in extractedText) {
	// 	console.log('🚀 ~ activeDrops ~ z', z);

	// 	if (z.toLocaleLowerCase().includes('drops')) x = true;
	// }
}

async function findChannelFromList(page: Page): Promise<boolean> {
	if (check.existsSync(file)) {
		await readList();
		for (let channel of list) {
			info(`Trying ${chalk.yellow(channel)}`);
			await page.goto(`https://twitch.tv/${channel}`, {
				waitUntil: ['networkidle2', 'domcontentloaded']
			});

			if (await channelExists(page)) {
				info(chalk.red(`${channel} not found or don't exist!`));
				continue;
			}

			const live = !(await isLive(page)).notLive;
			vinfo(`Channel live: ${live}`);
			if (!live) vinfo('Channel offline, trying next channel');
			else {
				if (game) {
					const _streamingGame = await streamingGame(page);
					vinfo(`Channel streaming the given game: ${_streamingGame}`);
					if (!_streamingGame) continue;
				}
				if (!(await activeDrops(page))) return false;
				info('Online channel found!');
				return true;
			}
		}
		info(
			chalk.magenta(
				`No channels online or streaming the selected game! Trying again after the timeout`
			)
		);
		return false;
	} else {
		info(chalk.magenta(`${file} not found. Please, make sure it exists`));
		return false;
	}
}

let browser: Browser;
let mainPage: Page;
let backupPage: Page;

async function findOnlineChannel(page: Page) {
	buffering = 0;
	prevDuration = -1;
	info('Finding online channel...');
	if (file && page === mainPage) {
		const found = await findChannelFromList(page);
		if (game && !found) {
			if (!backupPage) {
				info('Finding backup stream.');
				backupPage = await browser.newPage();
				await backupPage.setViewport({ width: 1280, height: 720 });
				await findRandomChannel(backupPage);
				// if (!(await activeDrops(backupPage))) {
				// 	info(chalk.magenta(`No active drops`));
				// 	await findRandomChannel(backupPage);
				// }
			} else {
				vinfo('Checking backup stream');
				await checkLiveStatus(backupPage);
			}
		} else if (found && backupPage) {
			info('Closing backup stream.');
			await backupPage.close();
			await page.bringToFront();
		}
	} else await findRandomChannel(page);
}

const INVENTORY_URL = 'https://www.twitch.tv/drops/inventory';

async function checkInventory(inventory: Page) {
	await inventory.goto(INVENTORY_URL, {
		waitUntil: ['networkidle2', 'domcontentloaded']
	});
	const claimButtons = await inventory.$$(
		'button[data-test-selector="DropsCampaignInProgressRewardPresentation-claim-button"]'
	);
	vinfo(
		`${claimButtons.length} claim buttons found${claimButtons.length > 0 ? '!' : '.'}`
	);

	if (claimButtons.length > 0) {
		info(
			`${claimButtons.length} drops found! Please head to ${INVENTORY_URL} to claim them!`
		);
	}
	// for (const claimButton of claimButtons) {
	//   info("Reward found! Claiming!");
	//   await new Promise((resolve) => setTimeout(resolve, 1000));
	//   await claimButton.click();
	//   await new Promise((resolve) => setTimeout(resolve, 1000));
	// }
}

async function isLive(channelPage: Page) {
	await channelPage.bringToFront();
	var status = await channelPage.$$eval('a[status]', (li) => {
		return li.pop()?.getAttribute('status');
	});

	console.log('🚀 ~ file: index.ts:299 ~ isLive ~ status', status);

	var videoDuration = await channelPage.$$eval(
		'video',
		(videos) => (videos.pop() as HTMLVideoElement)?.currentTime
	);
	var raid;
	var drops;
	var notLive;
	var _streamingGame;

	if (status != 'offline') {
		raid = channelPage.url().includes('?referrer=raid');
		drops = (await activeDrops(channelPage)) ? true : false;

		_streamingGame = (await streamingGame(channelPage)) ? true : false;

		vinfo(`Current url: ${channelPage.url()}`);
		vinfo(`Channel status: ${status}`);
		vinfo(`Video duration: ${videoDuration}`);
		vinfo(`Streaming game: ${_streamingGame}`);
		notLive = status !== 'live' || videoDuration === 0;
		return {
			videoDuration,
			notLive,
			raid,
			streamingGame: _streamingGame,
			drops
		};
	} else {
		vinfo(`Current url: ${channelPage.url()}`);
		vinfo(`Channel status: ${status}`);
		vinfo(`Video duration: ${videoDuration}`);
		vinfo(`Streaming game: ${_streamingGame}`);
		return {
			videoDuration,
			notLive,
			raid,
			streamingGame: _streamingGame,
			drops
		};
	}
}

async function checkLiveStatus(channelPage: Page) {
	const { videoDuration, notLive, raid, streamingGame, drops } = await isLive(
		channelPage
	);
	if (notLive || raid) {
		info(chalk.red('Channel offline'));
		await findOnlineChannel(channelPage);
		return;
	} else if (!streamingGame) {
		info('Channel not streaming game');
		await findOnlineChannel(channelPage);
		return;
	}
	if (videoDuration === prevDuration) {
		warn(
			'Stream buffering or offline. If this persists a new channel will be found next cycle'
		);
		if (++buffering > 1) {
			info('Channel offline or stream still buffering');
			await findOnlineChannel(channelPage);
			return;
		}
	} else {
		buffering = 0;
	}
	prevDuration = videoDuration;
}

async function runTimer(page: Page, inventory: Page) {
	vinfo('Timer function called');
	await checkInventory(inventory);
	await checkLiveStatus(page);
	setTimeout(runTimer, timeout, page, inventory);
}

async function run() {
	info('Starting application');
	info(`Infinity Mode: ${infinity ? chalk.green('ON') : chalk.red('OFF')}!`);

	browser = await puppeteer.launch({
		executablePath: process.env.TWITCH_CHROME_EXECUTABLE,
		headless: headless,
		args: proxy ? [`--proxy-server=${proxy}`] : [`--window-size=1380,960`]
	});
	mainPage = (await browser.pages())[0];
	await mainPage.setViewport({ width: 1280, height: 720 });
	await initTwitch(mainPage);

	const inventory = await browser.newPage();
	await inventory.setViewport({ width: 1280, height: 720 });
	await mainPage.bringToFront();

	await findOnlineChannel(mainPage);
	setTimeout(runTimer, timeout, mainPage, inventory);
}

run().then(() => {
	// Nothing
});
