package main

import (
	"fmt"
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("APP_PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/validate", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-User-Id", "dev-user")
		w.Header().Set("X-Actor-Id", "dev-actor")
		w.Header().Set("X-User-Permissons", "read")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("healthy"))
	})

	fmt.Printf("authorization-handler listening on :%s\n", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		fmt.Println("server error:", err)
	}
}
