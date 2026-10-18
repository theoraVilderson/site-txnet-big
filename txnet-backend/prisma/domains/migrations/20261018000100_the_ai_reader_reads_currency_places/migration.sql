-- F-116-p (ADR-0153 point 1): an offer's discount is rounded to its currency's
-- `decimalPlaces`, never a literal 2, so the AI reader reads the registry's code
-- and places — reference data, no tenant's rows, so no policy.
GRANT USAGE ON SCHEMA currency TO txnet_ai_reader;
GRANT SELECT ("code", "decimalPlaces") ON currency.currency TO txnet_ai_reader;
