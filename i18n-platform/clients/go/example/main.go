// Manual check: LOCALE_ADDR=localhost:50051 go run ./example
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	localeclient "github.com/txnet/i18n-platform/clients/go"
)

func main() {
	addr := os.Getenv("LOCALE_ADDR")
	if addr == "" {
		addr = "localhost:50051"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// No PreloadLangs -> load every language locale-service advertises.
	c, err := localeclient.New(ctx, localeclient.Config{
		Addr: addr, Scope: "backend", DefaultLang: "fa",
	})
	if err != nil {
		fmt.Println("FAIL:", err)
		os.Exit(1)
	}
	defer c.Close()
	c.StartWatch()

	fmt.Println("languages       =>", c.Languages())
	fmt.Println("fa otp.userNotFound =>", c.Translate("fa", "errors", "otp.userNotFound"))
	fmt.Println("resolve(en-US)  =>", c.ResolveLanguage("en-US,en;q=0.9"))
	metas, _ := c.AvailableLocales(ctx)
	for _, m := range metas {
		fmt.Printf("meta => %s %s dir=%s\n", m.GetCode(), m.GetNativeName(), m.GetDir())
	}
}
