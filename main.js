
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { Client } = require('whatsapp-web.js');
const messageMetadataMap = new Map(); // Maps WhatsApp message content to Telegram message IDs
const lastFiveMessages = []; // Store message content mapping

// Define a path for storing the session
const filePath = path.join(__dirname, 'session.json');

// Load the session if it exists
const loadSession = () => {
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    return null;
};

// Initialize the WhatsApp client
const whatsappClient = new Client({
    puppeteer: { headless: true },
    session: loadSession()
});

// Function to save session
function saveSession(session) {
    if (session && typeof session === 'object') {
        fs.writeFileSync(filePath, JSON.stringify(session));
    } else {
        console.error('Invalid session data:', session);
    }
}

// Initialize Telegram Bot
const telegramToken = '7387494954:AAHDc6fF1wDcMStxlVYO3evzK3E0xNses4Y';
const telegramBot = new TelegramBot(telegramToken, { polling: true });

// Fixed Owner ID
const OWNER_ID = '6003246364'; // Replace with the actual owner's Telegram ID

// Initialize SQLite for admin management
const db = new sqlite3.Database(':memory:');
db.serialize(() => {
    db.run("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT)");
});

// Store current selected WhatsApp chat and Telegram channel
let selectedWhatsAppChat = null;
let selectedTelegramChannel = null;
let isForwarding = false; // Flag to control message forwarding
let chatSetupCompleted = false; // Flag to indicate if the chat setup is complete
let isConnected = false; // Flag to track connection status
let lastResetTime = Date.now();
let isConnecting = false; // Track connection state
let qrCodeTimeout; // Track QR code timeout for cancellation
let qrCodeMessageId = null; // Track QR code message ID to cancel previous QR codes
let is_edit_message = false; // Flag to enable or disable message editing


// Paths to the cache and auth directories
const cacheDir = path.join(__dirname, '.wwebjs_cache');
// Function to delete a directory and its contents
function deleteDirectoryRecursive(directoryPath) {
    if (fs.existsSync(directoryPath)) {
        fs.readdirSync(directoryPath).forEach((file) => {
            const filePath = path.join(directoryPath, file);
            if (fs.statSync(filePath).isDirectory()) {
                deleteDirectoryRecursive(filePath); // Recurse into subdirectory
            } else {
                fs.unlinkSync(filePath); // Delete file
            }
        });
        fs.rmdirSync(directoryPath); // Remove directory
    }
}

// Function to check user role
function checkUserRole(userId, role, callback) {
    if (userId === OWNER_ID) {
        callback(true); // Owner has full access
    } else {
        db.get("SELECT role FROM users WHERE id = ? AND role = ?", [userId, role], (err, row) => {
            callback(!!row);
        });
    }
}

// Telegram command to connect WhatsApp
telegramBot.onText(/\/connect/, (msg) => {
    const userId = msg.from.id.toString();

    checkUserRole(userId, 'admin', (isAdmin) => {
        if (isAdmin || userId === OWNER_ID) {
            const chatId = msg.chat.id;
            if (isConnected) {
                telegramBot.sendMessage(chatId, `✅ <b>WhatsApp is already connected.</b>`, {
                    parse_mode: 'HTML'
                });
                return;
            }

            if (isConnecting) {
                telegramBot.sendMessage(chatId, `⏳ <b>A connection process is already in progress. Please wait for it to complete or use <code>/cancel</code> to stop it.</b>`, {
                    parse_mode: 'HTML'
                });
                return; // Block new connection attempts
            }

            isConnecting = true;

            // Send a bold and attractive wait message with emojis
            telegramBot.sendMessage(chatId, '⏳ <b>Please wait while we generate the QR code...</b>', { parse_mode: 'HTML' })
                .then((waitMessage) => {
                    const waitMessageId = waitMessage.message_id;
                    // Handle QR code generation
                    whatsappClient.on('qr', (qr) => {
                        if (!isConnecting) return; // Prevent further actions if canceled

                        qrcode.toDataURL(qr, (err, url) => {
                            if (err) {
                                console.error('QR Code generation error:', err);
                                telegramBot.sendMessage(chatId, 'Failed to generate QR code.');
                                isConnecting = false; // Reset state
                                return;
                            }

                            const base64Data = url.replace(/^data:image\/png;base64,/, '');
                            const buffer = Buffer.from(base64Data, 'base64');

                            // Send the QR code image to the user with an inline keyboard for cancel
                            const cancelKeyboard = {
                                inline_keyboard: [
                                    [{ text: '🚫 Cancel', callback_data: 'cancel' }]
                                ]
                            };

                            telegramBot.sendPhoto(chatId, buffer, {
                                caption: '📲 <b>Please scan this QR code to connect to WhatsApp.</b>',
                                parse_mode: 'HTML',
                                reply_markup: cancelKeyboard
                            }).then((photoMessage) => {
                                qrCodeMessageId = photoMessage.message_id;

                                // Delete the initial wait message after sending the QR code image
                                telegramBot.deleteMessage(chatId, waitMessageId).catch(err => {
                                    console.error('Error deleting wait message:', err);
                                });

                                // Set a timeout to allow the user to cancel the connection
                                qrCodeTimeout = setTimeout(() => {
                                    isConnecting = false;
                                    telegramBot.deleteMessage(chatId, qrCodeMessageId)
                                    telegramBot.sendMessage(chatId, '❌ Connection process timed out.');
                                }, 120000); // 2 minutes timeout

                            }).catch(err => {
                                console.error('Error sending QR code image:', err);
                                isConnecting = false; // Reset state
                                telegramBot.sendMessage(chatId, 'Failed to send QR code image.');
                            });
                        });
                    });

                    // Notify user upon successful login and delete the QR code image
                    whatsappClient.on('ready', (session) => {
                        isConnected = true;
                        isConnecting = false; // Reset the connecting flag
                        clearTimeout(qrCodeTimeout); // Clear any pending timeout

                        console.log('Session data:', session); // Add this line to debug

                        telegramBot.sendMessage(chatId, '✅ <b>Your WhatsApp account has been successfully logged in!</b>', {
                            parse_mode: 'HTML'
                        }).then(() => {
                            saveSession(session);
                            console.log('WhatsApp session saved.');

                            if (qrCodeMessageId) {
                                telegramBot.deleteMessage(chatId, qrCodeMessageId)
                                    .then(() => { })
                                    .catch(err => {
                                        console.error('Error deleting QR code message:', err);
                                    });
                            } else {
                                console.warn('No QR code message ID available for deletion.');
                            }

                        }).catch(err => {
                            console.error('Error sending login confirmation message:', err);
                        });
                    });

                    // Initialize the WhatsApp client
                    whatsappClient.initialize();
                })
                .catch(err => {
                    console.error('Error sending wait message:', err);
                });
        } else {
            telegramBot.sendMessage(msg.chat.id, `🚫 <b>You are not authorized to use this bot.</b>`, {
                parse_mode: 'HTML'
            });
        }
    });
});

// Command to disconnect WhatsApp session (Admins and Owner)
telegramBot.onText(/\/disconnect/, (msg) => {
    const userId = msg.from.id.toString();

    checkUserRole(userId, 'admin', (isAdmin) => {
        if (isAdmin || userId === OWNER_ID) {
            const chatId = msg.chat.id;

            if (!isConnected) {
                telegramBot.sendMessage(chatId, `⚠️ <b>WhatsApp is not connected.</b>`, {
                    parse_mode: 'HTML'
                });
                return;
            }

            // Create inline keyboard for confirmation
            const options = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Confirm', callback_data: 'confirm_disconnect' }],  // Adds a check mark emoji to the Confirm button
                        [{ text: '❌ Cancel', callback_data: 'cancel_disconnect' }]     // Adds a cross mark emoji to the Cancel button
                    ]
                }
            };


            telegramBot.sendMessage(chatId, 'Are you sure you want to disconnect WhatsApp?', options);
        } else {
            telegramBot.sendMessage(msg.chat.id, `🚫 <b>You are not authorized to use this bot.</b>`, {
                parse_mode: 'HTML'
            });
        }
    });
});

// Handle callback queries
telegramBot.on('callback_query', (callbackQuery) => {
    const msg = callbackQuery.message;
    if (!msg || !msg.chat || !callbackQuery.data) {
        console.error('Invalid callback query:', callbackQuery);
        return;
    }

    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const userId = callbackQuery.from.id.toString();

    switch (callbackQuery.data) {
        case 'confirm_disconnect':
            whatsappClient.logout().then(() => {
                isConnected = false;
                deleteDirectoryRecursive(cacheDir);
                resetBot()
                telegramBot.sendMessage(chatId, `🔌 <b>The WhatsApp session has been disconnected.</b>`, {
                    parse_mode: 'HTML'
                });
            }).catch((err) => {
                telegramBot.sendMessage(chatId, 'Failed to disconnect WhatsApp. Please check the logs for details.');
                console.error('Disconnection error:', err);
            });
            break;

        case 'cancel_disconnect':
            // Handle cancel disconnect if needed
            break;

        case 'cancel':
            if (userId === OWNER_ID) {
                if (isConnecting) {
                    isConnecting = false;
                    clearTimeout(qrCodeTimeout);

                    telegramBot.sendMessage(chatId, '❌ <b>WhatsApp connection process has been cancelled.</b>', {
                        parse_mode: 'HTML'
                    });

                    // Stop the WhatsApp client initialization if in progress
                    whatsappClient.removeAllListeners('qr'); // Stop listening for new QR codes
                    whatsappClient.removeAllListeners('ready'); // Stop listening for successful login
                    whatsappClient.destroy(); // Terminate WhatsApp client
                    whatsappClient.initialize(); // Reinitialize WhatsApp client to be ready for a new connection process
                } else {
                    telegramBot.sendMessage(chatId, 'There is no connection process to cancel.');
                }
            } else {
                telegramBot.sendMessage(chatId, 'No connection process is in progress.');
            }
            break;

        default:
            checkUserRole(userId, 'admin', (isAdmin) => {
                if (isAdmin || userId === OWNER_ID) {
                    const selectedChatId = callbackQuery.data;
                    whatsappClient.getChatById(selectedChatId).then(chat => {
                        if (!chat) {
                            telegramBot.sendMessage(chatId, 'Failed to retrieve chat details. Please try again.');
                            return;
                        }
                        selectedWhatsAppChat = chat;
                        telegramBot.sendMessage(chatId, `You selected the chat: ${chat.name || chat.id.user}`);
                        telegramBot.sendMessage(chatId, `🔍 <b>Please enter the Telegram channel ID where messages should be forwarded:</b>`, {
                            parse_mode: 'HTML'
                        });

                    }).catch(err => {
                        telegramBot.sendMessage(chatId, 'Failed to retrieve chat details. Please try again.');
                        console.error('Failed to retrieve chat details:', err);
                    });
                } else {
                    telegramBot.sendMessage(chatId, `🚫 <b>You are not authorized to use this bot.</b>`, {
                        parse_mode: 'HTML'
                    });
                }
            });
            break;
    }
    // Delete the original message with the inline keyboard after processing the callback
    telegramBot.deleteMessage(chatId, messageId).catch(err => {
        console.error('Failed to delete message:', err);
    });

    // Acknowledge the callback query
    telegramBot.answerCallbackQuery(callbackQuery.id).catch(err => console.error('Failed to answer callback query:', err));
});



// Handle /set_chat command
telegramBot.onText(/\/set_chat/, (msg) => {
    const userId = msg.from.id.toString();
    const chatId = msg.chat.id;

    checkUserRole(userId, 'admin', (isAdmin) => {
        if (isAdmin || userId === OWNER_ID) {
            if (!isConnected) {
                telegramBot.sendMessage(chatId, `🔗 <b>WhatsApp is not connected. Please connect it first using /connect.</b>`, {
                    parse_mode: 'HTML'
                });
                return;
            }

            whatsappClient.getChats().then(chats => {
                if (!chats || !chats.length) {
                    telegramBot.sendMessage(chatId, 'No WhatsApp chats found. Please ensure you have chats available.');
                    return;
                }
                const recentChats = chats.sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);
                const chatOptions = recentChats.map(chat => ({
                    text: chat.name || chat.id.user,
                    callback_data: chat.id._serialized
                }));

                telegramBot.sendMessage(chatId, '📲 <b>Select a WhatsApp chat to forward messages from:</b>', {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: chatOptions.map(option => [option]) }
                });

            }).catch(err => {
                telegramBot.sendMessage(chatId, 'Failed to retrieve WhatsApp chats. Please try again.');
                console.error('Failed to retrieve WhatsApp chats:', err);
            });
        } else {
            telegramBot.sendMessage(chatId, `🚫 <b>You are not authorized to use this bot.</b>`, {
                parse_mode: 'HTML'
            });
        }
    });
});

// Handle incoming messages
telegramBot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    if (msg.text && (msg.text.startsWith('-') || /^\d+$/.test(msg.text))) {
        let channelId = msg.text;

        if (!channelId.startsWith('-100')) {
            channelId = '-100' + channelId;
        }

        if (selectedWhatsAppChat) {
            checkUserRole(userId, 'admin', (isAdmin) => {
                if (isAdmin || userId === OWNER_ID) {
                    selectedTelegramChannel = channelId;
                    chatSetupCompleted = true;

                    telegramBot.sendMessage(chatId, `📢 <b>All messages and images from the selected WhatsApp chat will now be forwarded to the specified Telegram channel (ID: ${selectedTelegramChannel}).</b>`, {
                        parse_mode: 'HTML'
                    }).then(() => {
                        // Additional code here, if needed
                    });

                } else {
                    telegramBot.sendMessage(chatId, `🚫 <b>You are not authorized to use this bot.</b>`, {
                        parse_mode: 'HTML'
                    });
                }
            });
        } else {
            telegramBot.sendMessage(chatId, `🔄 <b>No WhatsApp chat has been selected. Please use /set_chat to select a chat first.</b>`, {
                parse_mode: 'HTML'
            });
        }
    }
});

// Handle polling errors
telegramBot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

// Add admin (Owner only)
telegramBot.onText(/\/addadmin (.+)/, (msg, match) => {
    const userId = msg.from.id.toString();

    if (userId === OWNER_ID) {
        const newAdminId = match[1];

        db.run("INSERT INTO users (id, role) VALUES (?, ?)", [newAdminId, 'admin'], (err) => {
            if (err) {
                telegramBot.sendMessage(msg.chat.id, 'Failed to add admin.');
            } else {
                telegramBot.sendMessage(msg.chat.id, `👤 <b>Added admin with ID: ${newAdminId}</b>`, {
                    parse_mode: 'HTML'
                });
            }
        });
    } else {
        telegramBot.sendMessage(msg.chat.id, `🚫 <b>You are not authorized to use this bot.</b>`, {
            parse_mode: 'HTML'
        });
    }
});

// Remove admin (Owner only)
telegramBot.onText(/\/removeadmin (.+)/, (msg, match) => {
    const userId = msg.from.id.toString();

    if (userId === OWNER_ID) {
        const adminId = match[1];

        db.run("DELETE FROM users WHERE id = ? AND role = 'admin'", [adminId], (err) => {
            if (err) {
                telegramBot.sendMessage(msg.chat.id, 'Failed to remove admin.');
            } else {
                telegramBot.sendMessage(msg.chat.id, `❌ <b>Removed admin with ID: ${adminId}</b>`, {
                    parse_mode: 'HTML'
                });
            }
        });
    } else {
        telegramBot.sendMessage(msg.chat.id, `🚫 <b>You are not authorized to use this bot.</b>`, {
            parse_mode: 'HTML'
        });
    }
});


// Function to get the time until the next reset
function getTimeUntilNextReset() {
    const now = Date.now();
    const timePassed = now - lastResetTime;
    const timeUntilNextReset = Math.max(0, 14400000 - timePassed); // 30 minutes in milliseconds

    const minutes = Math.floor(timeUntilNextReset / 60000);
    const seconds = Math.floor((timeUntilNextReset % 60000) / 1000);

    return `${minutes} minutes and ${seconds} seconds`;
}

// Settings (Admins and Owner)
telegramBot.onText(/\/settings/, (msg) => {
    const userId = msg.from.id.toString();

    checkUserRole(userId, 'admin', (isAdmin) => {
        if (isAdmin || userId === OWNER_ID) {
            let message = "<b>⚙️ Settings:</b>\n\n";
            message += `<b>🔄 Forwarding is currently:</b> ${isForwarding ? 'ON 🟢' : 'OFF 🔴'}\n\n`;
            message += `<b>⏳ Next automatic reset in:</b> ${getTimeUntilNextReset()}\n\n`;

            if (selectedWhatsAppChat && selectedTelegramChannel) {
                message += `<b>📤 Forwarding setup:</b>\n`;
                message += `- <b>From WhatsApp Chat:</b> ${selectedWhatsAppChat.name || selectedWhatsAppChat.id.user}\n`;
                message += `- <b>To Telegram Channel:</b> ${selectedTelegramChannel}\n\n`;
                message += `<b>Message Editing:</b> ${is_edit_message}\n\n`
            } else {
                message += `<b>⚠️ Forwarding setup is not completed yet.</b>\n\n`;
            }

            if (userId === OWNER_ID) {
                // Fetch and display the list of admins to the owner only
                db.all("SELECT id FROM users WHERE role = 'admin'", (err, rows) => {
                    if (err) {
                        telegramBot.sendMessage(msg.chat.id, '❌ Failed to fetch admin list.');
                    } else {
                        if (rows.length > 0) {
                            message += `<b>👮‍♂️ Admins:</b>\n`;
                            rows.forEach(row => {
                                message += `- ${row.id}\n`;
                            });
                        } else {
                            message += `No admins found.\n`;
                        }
                        telegramBot.sendMessage(msg.chat.id, message, { parse_mode: "HTML" });
                    }
                });
            } else {
                telegramBot.sendMessage(msg.chat.id, message, { parse_mode: "HTML" });
            }
        } else {
            telegramBot.sendMessage(msg.chat.id, '❌ You are not authorized to use this bot.');
        }
    });
});


// Command to start forwarding messages (only if chat setup is complete)
telegramBot.onText(/\/run/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    // Check if the user is an admin or the owner
    checkUserRole(userId, 'admin', async (isAdmin) => {
        if (isAdmin || userId === OWNER_ID) {
            if (chatSetupCompleted) {
                if (!isForwarding) {
                    isForwarding = true; // Enable forwarding
                    await telegramBot.sendMessage(chatId, `🚀 <b>Forwarding has been started.</b>`, {
                        parse_mode: 'HTML'
                    });
                } else {
                    await telegramBot.sendMessage(chatId, '⚠️ <b>Forwarding is already in progress.</b>', {
                        parse_mode: 'HTML'
                    });

                }
            } else {
                await telegramBot.sendMessage(chatId, '⚠️ <b>Please complete the chat setup using /set_chat before running this command.</b>', {
                    parse_mode: 'HTML'
                });

            }
        } else {
            await telegramBot.sendMessage(chatId, '❌ You are not authorized to use this bot.');
        }
    });
});

// Command to stop forwarding messages
telegramBot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    checkUserRole(userId, 'admin', (isAdmin) => {
        if (isAdmin || userId === OWNER_ID) {
            if (isForwarding) {
                isForwarding = false; // Disable forwarding
                telegramBot.sendMessage(chatId, `⛔ <b>Message forwarding has been stopped.</b>`, {
                    parse_mode: 'HTML'
                });
            } else {
                telegramBot.sendMessage(chatId, '🔄 <b>Message forwarding is not currently active.</b>', {
                    parse_mode: 'HTML'
                });

            }
        } else {
            telegramBot.sendMessage(chatId, '❌ You are not authorized to use this bot.');
        }
    });
});

telegramBot.onText(/\/edit_message/, (msg) => {
    const chatId = msg.chat.id;

    // Toggle message editing
    is_edit_message = !is_edit_message;

    let status = is_edit_message ? 'enabled' : 'disabled';
    telegramBot.sendMessage(chatId, `✏️ <b>Message editing is now ${status}.</b>`, {
        parse_mode: 'HTML'
    });
});


// Function to reset the bot state and update lastResetTime
function resetBot() {
    selectedWhatsAppChat = null;
    selectedTelegramChannel = null;
    chatSetupCompleted = false;
    isForwarding = false;
    is_edit_message = false
    lastResetTime = Date.now(); // Update the last reset timestamp
}

// Schedule automatic reset every 30 minutes
let resetInterval = setInterval(resetBot, 14400000); // 30 minutes in milliseconds

// Update the automatic reset timer after a manual reset
telegramBot.onText(/\/reset/, (msg) => {
    const userId = msg.from.id.toString();

    checkUserRole(userId, 'admin', (isAdmin) => {
        if (isAdmin || userId === OWNER_ID) {
            resetBot(); // Perform the reset

            telegramBot.sendMessage(msg.chat.id, '✨ Settings have been reset to default.');

            clearInterval(resetInterval);
            resetInterval = setInterval(resetBot, 14400000); // Reschedule automatic reset
        } else {
            telegramBot.sendMessage(msg.chat.id, `🚫 <b>You are not authorized to use this bot.</b>`, {
                parse_mode: 'HTML'
            });
        }
    });
});

// Command to display all commands and instructions
telegramBot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    checkUserRole(userId, 'admin', (isAdmin) => {
        let message = "<b>🚀 Welcome! Here are the available commands:</b>\n\n";

        // Common commands for all users
        message += "<b>🔗 /connect</b> - Starts WhatsApp connection and generates a QR code for scanning.\n\n";
        message += "<b>❌ /disconnect</b> - Logs out of WhatsApp. Requires confirmation.\n\n";
        message += "<b>💬 /set_chat</b> - Selects a WhatsApp chat for message forwarding.\n\n";
        message += "<b>▶️ /run</b> - Starts forwarding messages to the Telegram channel. Requires chat setup.\n\n";
        message += "<b>⏹️ /stop</b> - Stops message forwarding.\n\n";
        message += "<b>⚙️ /settings</b> - Shows current settings.\n\n";
        message += "<b>🔄 /reset</b> - Resets the Settings.\n\n";
        message += "<b>✏️ /edit_message</b> - Toggles message editing on/off.\n\n";

        // Additional commands for admins and owner
        if (isAdmin || userId === OWNER_ID) {
            message += "<b>👮‍♂️ Admin Commands:</b>\n\n";
            message += "<b>➕ /addadmin &lt;user_id&gt;</b> - Adds a user as admin (Owner only).\n\n";
            message += "<b>➖ /removeadmin &lt;user_id&gt;</b> - Removes a user from admin list (Owner only).\n\n";
        }

        telegramBot.sendMessage(chatId, message, { parse_mode: "HTML" });
    });
});

// Function to store the last 5 messages by content
function storeLastFiveMessages(messageContent, messageId) {
    if (lastFiveMessages.length >= 5) {
        lastFiveMessages.shift(); // Remove the oldest message if there are already 5 messages
    }
    lastFiveMessages.push({ content: messageContent, id: messageId }); // Add the new message content and ID
}

// Forwarding messages
whatsappClient.on('message', async (msg) => {
    if (isForwarding && selectedWhatsAppChat && msg.from === selectedWhatsAppChat.id._serialized) {
        try {
            storeLastFiveMessages(msg.body, msg.id._serialized);

            let messageContent = msg.body;
            let telegramMessageId;

            if (msg.hasMedia) {
                const media = await msg.downloadMedia();
                if (media) {
                    const buffer = Buffer.from(media.data, 'base64');
                    let sentMessage;

                    if (media.mimetype.startsWith('image/')) {
                        sentMessage = await telegramBot.sendPhoto(selectedTelegramChannel, buffer, { caption: messageContent });
                    } else if (media.mimetype.startsWith('video/')) {
                        sentMessage = await telegramBot.sendVideo(selectedTelegramChannel, buffer, { caption: messageContent });
                    } else if (media.mimetype.startsWith('audio/')) {
                        sentMessage = await telegramBot.sendAudio(selectedTelegramChannel, buffer);
                    } else if (media.mimetype.startsWith('application/')) {
                        sentMessage = await telegramBot.sendDocument(selectedTelegramChannel, buffer, { caption: messageContent });
                    } else {
                        await telegramBot.sendMessage(selectedTelegramChannel, 'Unsupported media type received.');
                        console.log('Unsupported media type:', media.mimetype);
                    }

                    telegramMessageId = sentMessage.message_id;
                }
            } else {
                const sentMessage = await telegramBot.sendMessage(selectedTelegramChannel, messageContent);
                telegramMessageId = sentMessage.message_id;
            }

            // Map WhatsApp message ID to metadata
            messageMetadataMap.set(msg.id._serialized, {
                telegramMessageId: telegramMessageId,
                originalContent: messageContent
            });
            console.log(`Forwarded WhatsApp message content to Telegram message ID: ${telegramMessageId}`);
        } catch (error) {
            await telegramBot.sendMessage(selectedTelegramChannel, 'Failed to forward message.');
            console.error('Error forwarding message:', error);
        }
    }
});

async function pollForUpdates() {
    if (!is_edit_message) return; // Exit if message editing is not enabled

    if (!selectedWhatsAppChat) {
        console.error('No WhatsApp chat is selected for polling.');
        return;
    }

    try {
        // Retrieve the chat object
        const chatss = await whatsappClient.getChat(selectedWhatsAppChat.id._serialized);

        // Fetch the last 5 messages
        const messages = await chatss.fetchMessages({ limit: 5 });

        for (const message of messages) {
            const whatsappMessageId = message.id._serialized;
            const newContent = message.body;

            if (messageMetadataMap.has(whatsappMessageId)) {
                const metadata = messageMetadataMap.get(whatsappMessageId);

                // Check if the content has changed
                if (newContent !== metadata.originalContent) {
                    // Update the Telegram message
                    await telegramBot.editMessageText(newContent, {
                        chat_id: selectedTelegramChannel,
                        message_id: metadata.telegramMessageId
                    });
                    console.log(`Updated Telegram message content to: ${newContent}`);

                    // Update metadata
                    messageMetadataMap.set(whatsappMessageId, {
                        telegramMessageId: metadata.telegramMessageId,
                        originalContent: newContent
                    });
                }
            }
        }
    } catch (error) {
        console.error('Error polling message updates:', error);
    }
}

// Set up polling to run every 2 seconds
setInterval(pollForUpdates, 2000);

// Handle deleted messages
whatsappClient.on('message_deleted', async (msg) => {
    try {
        const messageId = msg.id._serialized;

        if (messageMetadataMap.has(messageId)) {
            const metadata = messageMetadataMap.get(messageId);
            const telegramMessageId = metadata.telegramMessageId;

            // Delete the corresponding Telegram message
            await telegramBot.deleteMessage(selectedTelegramChannel, telegramMessageId);
            messageMetadataMap.delete(messageId);
            console.log(`Deleted Telegram message with content: ${metadata.originalContent}`);
        } else {
            console.log(`Message ID ${messageId} is not in the metadata map.`);
        }
    } catch (error) {
        console.error('Error deleting Telegram message:', error);
    }
});
