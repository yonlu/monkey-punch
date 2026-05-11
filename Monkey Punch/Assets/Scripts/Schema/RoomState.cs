using Colyseus.Schema;
#if UNITY_5_3_OR_NEWER
using UnityEngine.Scripting;
#endif

namespace MonkeyPunch.Wire {

public partial class RoomState : Schema {
#if UNITY_5_3_OR_NEWER
[Preserve]
#endif
public RoomState() { }
	[Type(0, "string")]
	public string code = default(string);

	[Type(1, "uint32")]
	public uint seed = default(uint);

	[Type(2, "uint32")]
	public uint tick = default(uint);

	[Type(3, "map", typeof(MapSchema<Player>))]
	public MapSchema<Player> players = null;

	[Type(4, "map", typeof(MapSchema<Enemy>))]
	public MapSchema<Enemy> enemies = null;

	[Type(5, "map", typeof(MapSchema<Gem>))]
	public MapSchema<Gem> gems = null;

	[Type(6, "map", typeof(MapSchema<BloodPool>))]
	public MapSchema<BloodPool> bloodPools = null;

	[Type(7, "boolean")]
	public bool runEnded = default(bool);

	[Type(8, "uint32")]
	public uint runEndedTick = default(uint);
}

}
