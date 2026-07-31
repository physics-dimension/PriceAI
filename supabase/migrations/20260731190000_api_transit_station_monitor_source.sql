alter table api_transit_stations
  drop constraint if exists api_transit_stations_availability_source_type_check;

alter table api_transit_stations
  add constraint api_transit_stations_availability_source_type_check
  check (
    availability_source_type in (
      'priceai_probe',
      'station_monitor',
      'public_status',
      'public_model_catalog',
      'partner_api',
      'merchant_reported',
      'manual_snapshot',
      'unknown'
    )
  );

alter table api_transit_offers
  drop constraint if exists api_transit_offers_availability_source_type_check;

alter table api_transit_offers
  add constraint api_transit_offers_availability_source_type_check
  check (
    availability_source_type in (
      'priceai_probe',
      'station_monitor',
      'public_status',
      'public_model_catalog',
      'partner_api',
      'merchant_reported',
      'manual_snapshot',
      'unknown'
    )
  );

alter table api_transit_availability_samples
  drop constraint if exists api_transit_availability_samples_source_type_check;

alter table api_transit_availability_samples
  add constraint api_transit_availability_samples_source_type_check
  check (
    source_type in (
      'priceai_probe',
      'station_monitor',
      'public_status',
      'public_model_catalog',
      'partner_api',
      'merchant_reported',
      'manual_snapshot',
      'unknown'
    )
  );
