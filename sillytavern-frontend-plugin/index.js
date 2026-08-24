/**
 * st-lite-agent 前端插件骨架。
 * 安装到 <SillyTavern>/data/<用户>/extensions/st-lite-agent/ 并在「扩展」面板启用。
 */
import { eventSource, event_types } from '../../../../script.js';
import { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE } from '../../../../slash-commands/SlashCommandArgument.js';

const MODULE_NAME = 'st-lite-agent';

const pingCommand = SlashCommand.fromProps({
    name: 'lite-agent',
    callback: () => 'pong —— st-lite-agent 前端插件已加载',
    helpString: '检查 st-lite-agent 前端插件是否正常加载',
    returns: ARGUMENT_TYPE.STRING,
});

jQuery(async () => {
    SlashCommandParser.addCommandObject(pingCommand);
    console.log('[' + MODULE_NAME + '] 前端插件已加载');
});

