// locale-service is the source of truth for translations. It serves the
// LocaleService gRPC contract (proto/locale/v1/locale.proto) and live-reloads
// from the on-disk locales/ tree.
//
//	LOCALES_DIR=../../locales GRPC_ADDR=:50051 go run ./cmd/server
//
// `locale-service -healthcheck` dials its own gRPC health endpoint and exits
// 0/1 — used as the container HEALTHCHECK (no extra probe binary needed).
package main

import (
	"context"
	"log"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"

	"github.com/txnet/i18n-platform/services/locale-service/internal/localev1"
	"github.com/txnet/i18n-platform/services/locale-service/internal/server"
	"github.com/txnet/i18n-platform/services/locale-service/internal/store"
	"github.com/txnet/i18n-platform/services/locale-service/internal/watcher"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// dialTarget turns a listen addr (":50051" / "0.0.0.0:50051") into something a
// client can dial ("localhost:50051").
func dialTarget(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return "localhost" + addr
	}
	if strings.HasPrefix(addr, "0.0.0.0:") {
		return "localhost:" + strings.TrimPrefix(addr, "0.0.0.0:")
	}
	return addr
}

func runHealthcheck(addr string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, err := grpc.NewClient(dialTarget(addr), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Printf("healthcheck: dial: %v", err)
		os.Exit(1)
	}
	defer conn.Close()

	resp, err := healthpb.NewHealthClient(conn).Check(ctx, &healthpb.HealthCheckRequest{})
	if err != nil {
		log.Printf("healthcheck: %v", err)
		os.Exit(1)
	}
	if resp.GetStatus() != healthpb.HealthCheckResponse_SERVING {
		log.Printf("healthcheck: status = %s", resp.GetStatus())
		os.Exit(1)
	}
	os.Exit(0)
}

func main() {
	addr := envOr("GRPC_ADDR", ":50051")

	if len(os.Args) > 1 && (os.Args[1] == "-healthcheck" || os.Args[1] == "--healthcheck") {
		runHealthcheck(addr)
		return
	}

	localesDir := envOr("LOCALES_DIR", "./locales")

	st := store.New(localesDir)
	srv := server.New(st)

	stopWatch, err := watcher.Watch(st, srv.OnStoreChange)
	if err != nil {
		log.Fatalf("[locale-service] watcher init failed: %v", err)
	}
	defer stopWatch()

	lis, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("[locale-service] listen %s: %v", addr, err)
	}

	grpcServer := grpc.NewServer()
	localev1.RegisterLocaleServiceServer(grpcServer, srv)

	hs := health.NewServer()
	hs.SetServingStatus("", healthpb.HealthCheckResponse_SERVING) // overall
	hs.SetServingStatus("locale.v1.LocaleService", healthpb.HealthCheckResponse_SERVING)
	healthpb.RegisterHealthServer(grpcServer, hs)
	reflection.Register(grpcServer)

	go func() {
		log.Printf("[locale-service] gRPC listening on %s, locales dir: %s", addr, localesDir)
		if err := grpcServer.Serve(lis); err != nil {
			log.Fatalf("[locale-service] serve: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	log.Println("[locale-service] shutting down...")
	grpcServer.GracefulStop()
}
