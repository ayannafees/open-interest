const crypto = require('crypto');

/**
 * Smart Order Router (SOR)
 * Enforces Invariant EX-05 (Venue Topic Isolation) and
 * Unknown Symbol Guard with Dead-Letter routing.
 */
class SmartOrderRouter {
    constructor(kafkaProducer = null) {
        this.producer = kafkaProducer;

        // Invariant EX-05: Instrument to Venue Topic Mapping
        this.venueMap = {
            'GC Dec27': { topic: 'raw_orders_comex', exchange: 'COMEX', tickSize: 0.10 },
            'CL Dec27': { topic: 'raw_orders_nymex', exchange: 'NYMEX', tickSize: 0.01 },
            'SR3 Dec27': { topic: 'raw_orders_cme', exchange: 'CME', tickSize: 0.005 },
            'CRA Dec27': { topic: 'raw_orders_mx', exchange: 'MX', tickSize: 0.005 },
            'ER3 Jun26': { topic: 'raw_orders_ice', exchange: 'ICE', tickSize: 0.005 }
        };
    }

    /**
     * Resolve destination venue metadata for an instrument (EX-05)
     */
    resolveVenue(instrument) {
        return this.venueMap[instrument] || null;
    }

    /**
     * Route an order to its target venue topic, or dead-letter topic if unknown
     */
    routeOrder(order) {
        const venue = this.resolveVenue(order.instrument);
        const orderId = order.id || crypto.randomUUID();

        // Unknown Symbol Guard: If unmapped, route to dead_letter with REJECTED event
        if (!venue) {
            return {
                isDeadLetter: true,
                topic: 'dead_letter',
                exchange: 'UNKNOWN',
                payload: {
                    id: orderId,
                    traderId: order.traderId,
                    instrument: order.instrument,
                    rawOrder: order,
                    error: 'UNKNOWN_VENUE',
                    timestamp: new Date().toISOString()
                },
                rejectionEvent: {
                    orderId,
                    traderId: order.traderId,
                    instrument: order.instrument,
                    status: 'REJECTED',
                    reason: 'UNKNOWN_VENUE',
                    timestamp: new Date().toISOString()
                }
            };
        }

        return {
            isDeadLetter: false,
            topic: venue.topic,
            exchange: venue.exchange,
            payload: {
                id: orderId,
                traderId: order.traderId,
                instrument: order.instrument,
                side: order.side,
                type: order.type || 'LIMIT',
                price: Number(order.price),
                qty: parseInt(order.qty, 10),
                tif: order.tif || 'DAY',
                timestamp: new Date().toISOString()
            }
        };
    }

    /**
     * Route an order cancellation request
     */
    routeCancel(cancelRequest) {
        const venue = this.resolveVenue(cancelRequest.instrument);
        if (!venue) {
            return {
                isDeadLetter: true,
                topic: 'dead_letter',
                payload: { ...cancelRequest, error: 'UNKNOWN_VENUE', timestamp: new Date().toISOString() }
            };
        }

        return {
            isDeadLetter: false,
            topic: venue.topic,
            exchange: venue.exchange,
            payload: {
                action: 'CANCEL',
                orderId: cancelRequest.orderId,
                traderId: cancelRequest.traderId,
                instrument: cancelRequest.instrument,
                timestamp: new Date().toISOString()
            }
        };
    }

    /**
     * Publish a routed package to Kafka (handles both normal and dead_letter routing)
     */
    async dispatch(routedPackage) {
        if (!this.producer) {
            throw new Error('Kafka Producer not connected to SOR');
        }

        const { topic, payload, isDeadLetter, rejectionEvent } = routedPackage;

        // 1. Publish to target topic (venue topic or dead_letter)
        await this.producer.send({
            topic,
            messages: [{
                key: payload.instrument || payload.id,
                value: JSON.stringify(payload)
            }]
        });

        // 2. If Dead Letter: Also publish rejection event to 'order_events' topic
        if (isDeadLetter && rejectionEvent) {
            await this.producer.send({
                topic: 'order_events',
                messages: [{
                    key: rejectionEvent.orderId,
                    value: JSON.stringify(rejectionEvent)
                }]
            });
        }

        return {
            status: isDeadLetter ? 'DEAD_LETTERED' : 'DISPATCHED',
            topic,
            orderId: payload.id || payload.orderId
        };
    }
}

module.exports = SmartOrderRouter;