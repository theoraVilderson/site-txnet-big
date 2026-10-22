package driver_test

import (
	"testing"

	"network-service/internal/driver"
)

// F-210: a source names a client's Telegram account as a number (3x-ui's
// tgId) or as free text (a Marzban note); only a plain positive id is one.
func TestTelegramIDOf(t *testing.T) {
	cases := map[string]string{
		"123456789":               "123456789",
		" 123456789 ":             "123456789",
		"0":                       "",
		"-1001234":                "",
		"ali 1234":                "",
		"@ali":                    "",
		"":                        "",
		"12345678901234567890123": "",
		"۱۲۳۴۵۶":                  "",
	}
	for in, want := range cases {
		if got := driver.TelegramIDOf(in); got != want {
			t.Errorf("TelegramIDOf(%q) = %q, want %q", in, got, want)
		}
	}
	if got := driver.TelegramIDOfNumber(987654321); got != "987654321" {
		t.Errorf("TelegramIDOfNumber = %q", got)
	}
	if got := driver.TelegramIDOfNumber(0); got != "" {
		t.Errorf("TelegramIDOfNumber(0) = %q, want none", got)
	}
}
