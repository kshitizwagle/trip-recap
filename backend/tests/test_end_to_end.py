import asyncio
from datetime import datetime, timedelta
from pathlib import Path

from app.models.media import GPSQuality, MediaPoint, MediaType
from app.models.route import Coordinate, RouteSegment
from app.routing.builder import build_route
from app.timeline.builder import TimelineBuilder
from app.trip.builder import TripBuilder


class FakeRouter:
    async def route(self,start:Coordinate,end:Coordinate,start_observation_id:str,end_observation_id:str)->RouteSegment:
        return RouteSegment(start_observation_id=start_observation_id,end_observation_id=end_observation_id,geometry=[start,end],distance_meters=1000,duration_seconds=120)


def test_synthetic_trip_pipeline() -> None:
    base=datetime(2026,9,17,8,0)
    media=[
        MediaPoint(id="a",filename="a.jpg",path=Path("a.jpg"),media_type=MediaType.PHOTO,captured_at=base,latitude=40.75,longitude=-74.0,gps_quality=GPSQuality.VALID),
        MediaPoint(id="b",filename="b.jpg",path=Path("b.jpg"),media_type=MediaType.PHOTO,captured_at=base+timedelta(hours=1),latitude=40.78,longitude=-73.97,gps_quality=GPSQuality.VALID),
    ]
    trip=TripBuilder().build(media)[0]; route=asyncio.run(build_route(trip,FakeRouter())); timeline=TimelineBuilder().build(trip)
    assert len(trip.observations)==2
    assert route.distance_meters==1000
    assert route.as_geojson()["geometry"]["type"]=="LineString"
    assert timeline.duration_seconds>0
