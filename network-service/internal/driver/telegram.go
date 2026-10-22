package driver

import (
	"strconv"
	"strings"
)

// TelegramIDOf is the Telegram account a source names in text — a Marzban
// note, an x-ui fork's tgId sent as a string — or "" when it is not plainly
// one: ASCII digits only, a positive 64-bit id. An import links it to the
// reseller's bot (F-210); text that only looks like one is never guessed at.
func TelegramIDOf(text string) string {
	text = strings.TrimSpace(text)
	for _, r := range text {
		if r < '0' || r > '9' {
			return ""
		}
	}
	id, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return ""
	}
	return TelegramIDOfNumber(id)
}

// TelegramIDOfNumber is a numeric tgId as TelegramIDOf answers it; 0 (3x-ui's
// "none") and a negative group id are no account.
func TelegramIDOfNumber(id int64) string {
	if id <= 0 {
		return ""
	}
	return strconv.FormatInt(id, 10)
}
