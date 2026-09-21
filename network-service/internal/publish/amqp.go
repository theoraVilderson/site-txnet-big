package publish

import (
	"context"
	"fmt"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// The AMQP half of the publish path, and deliberately the thin one: the shape
// of the message is proved against the Transport interface without a broker,
// and what is left here is the part only a broker can answer.
//
// It is the Go copy of `shared-core/src/lib/automation/confirm-publish.ts`
// (F-067-f), for the same reason and with the same two answers:
//
//   - **The confirm** says the broker took responsibility for the message.
//   - **The return** says where it went, and a confirm does not cover it: AMQP
//     acks a publish to an exchange with no matching binding exactly as
//     happily as one that reached a queue. Until F-027-n binds
//     `network.usage.#`, every pass is unroutable — and that has to be an
//     error, because a cursor moved past bytes nobody queued is bytes nobody
//     will read again (invariant 18).
//
// RabbitMQ sends `basic.return` **before** the `basic.ack` of an unroutable
// mandatory message, which is the whole correlation mechanism: by the time a
// confirm arrives, a returned message id is already known.

// DefaultConfirmTimeout bounds how long one message waits for its confirm. A
// pass is a minute; a publish that has not been answered in ten seconds is a
// broker that will not answer, and the next pass re-reads the same bytes.
const DefaultConfirmTimeout = 10 * time.Second

// AMQPOptions is what dialing needs. Exchange defaults to DefaultExchange.
type AMQPOptions struct {
	URL            string
	Exchange       string
	ConfirmTimeout time.Duration
}

// AMQP is a Transport over one channel in confirm mode. One channel is shared
// by every panel in flight, so publishing is serialised by a mutex: an AMQP
// channel is not safe for concurrent use, and the cost is nothing beside the
// network round trip each publish already waits for.
type AMQP struct {
	conn     *amqp.Connection
	channel  *amqp.Channel
	exchange string
	timeout  time.Duration

	mu       sync.Mutex
	returned map[string]struct{}
	returns  chan amqp.Return
	confirms chan amqp.Confirmation
}

// DialAMQP connects, asserts the exchange and puts the channel in confirm
// mode. The exchange is asserted durable and topic, matching what every other
// publisher on it asserts; asserting it differently is a channel error, which
// is the loud version of two services disagreeing about one exchange.
func DialAMQP(opts AMQPOptions) (*AMQP, error) {
	exchange := opts.Exchange
	if exchange == "" {
		exchange = DefaultExchange
	}
	timeout := opts.ConfirmTimeout
	if timeout <= 0 {
		timeout = DefaultConfirmTimeout
	}

	conn, err := amqp.Dial(opts.URL)
	if err != nil {
		return nil, fmt.Errorf("dial broker: %w", err)
	}
	channel, err := conn.Channel()
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("open channel: %w", err)
	}
	if err := channel.ExchangeDeclare(exchange, amqp.ExchangeTopic, true, false, false, false, nil); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("assert exchange %s: %w", exchange, err)
	}
	if err := channel.Confirm(false); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("put channel in confirm mode: %w", err)
	}

	return &AMQP{
		conn: conn, channel: channel, exchange: exchange, timeout: timeout,
		returned: map[string]struct{}{},
		returns:  channel.NotifyReturn(make(chan amqp.Return, 64)),
		confirms: channel.NotifyPublish(make(chan amqp.Confirmation, 64)),
	}, nil
}

// drainReturns moves every return the broker has already sent into the set.
// It is called after a confirm, never in a goroutine of its own: the library
// feeds both channels from one connection reader in frame order, so a return
// that belongs to the message just confirmed is already buffered by then. A
// watcher goroutine would be the same information with a race in front of it.
func (a *AMQP) drainReturns() {
	for {
		select {
		case ret, ok := <-a.returns:
			if !ok {
				return
			}
			a.returned[ret.MessageId] = struct{}{}
		default:
			return
		}
	}
}

// Publish sends one message `mandatory` and waits for the broker's answer. It
// returns an error unless the message was both confirmed and not returned.
func (a *AMQP) Publish(ctx context.Context, routingKey, messageID string, body []byte) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	publishCtx, cancel := context.WithTimeout(ctx, a.timeout)
	defer cancel()

	if err := a.channel.PublishWithContext(publishCtx, a.exchange, routingKey, true, false, amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		MessageId:    messageID,
		Timestamp:    time.Now().UTC(),
		Body:         body,
	}); err != nil {
		return fmt.Errorf("publish %s: %w", routingKey, err)
	}

	select {
	case confirm, ok := <-a.confirms:
		if !ok {
			return fmt.Errorf("publish %s: the channel closed before it was confirmed", routingKey)
		}
		if !confirm.Ack {
			return fmt.Errorf("publish %s: the broker refused it", routingKey)
		}
	case <-publishCtx.Done():
		return fmt.Errorf("publish %s: not confirmed within %s", routingKey, a.timeout)
	}

	a.drainReturns()
	if _, unroutable := a.returned[messageID]; unroutable {
		delete(a.returned, messageID)
		return fmt.Errorf("publish %s: reached no queue on %s", routingKey, a.exchange)
	}
	return nil
}

// Close shuts the connection down. The channel goes with it.
func (a *AMQP) Close() error { return a.conn.Close() }
