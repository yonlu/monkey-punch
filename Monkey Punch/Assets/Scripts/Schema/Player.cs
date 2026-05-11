using Colyseus.Schema;
#if UNITY_5_3_OR_NEWER
using UnityEngine.Scripting;
#endif

namespace MonkeyPunch.Wire {

public partial class Player : Schema {
#if UNITY_5_3_OR_NEWER
[Preserve]
#endif
public Player() { }
	[Type(0, "string")]
	public string sessionId = default(string);

	[Type(1, "string")]
	public string name = default(string);

	[Type(2, "number")]
	public float x = default(float);

	[Type(3, "number")]
	public float y = default(float);

	[Type(4, "number")]
	public float z = default(float);

	[Type(5, "number")]
	public float vy = default(float);

	[Type(6, "boolean")]
	public bool grounded = default(bool);

	[Type(7, "uint32")]
	public uint lastGroundedAt = default(uint);

	[Type(8, "int32")]
	public int jumpBufferedAt = default(int);

	[Type(9, "ref", typeof(Vec2))]
	public Vec2 inputDir = null;

	[Type(10, "uint32")]
	public uint lastProcessedInput = default(uint);

	[Type(11, "uint32")]
	public uint xp = default(uint);

	[Type(12, "uint8")]
	public byte level = default(byte);

	[Type(13, "array", typeof(ArraySchema<WeaponState>))]
	public ArraySchema<WeaponState> weapons = null;

	[Type(14, "array", typeof(ArraySchema<ItemState>))]
	public ArraySchema<ItemState> items = null;

	[Type(15, "boolean")]
	public bool pendingLevelUp = default(bool);

	[Type(16, "array", typeof(ArraySchema<LevelUpChoice>))]
	public ArraySchema<LevelUpChoice> levelUpChoices = null;

	[Type(17, "uint32")]
	public uint levelUpDeadlineTick = default(uint);

	[Type(18, "uint16")]
	public ushort hp = default(ushort);

	[Type(19, "uint16")]
	public ushort maxHp = default(ushort);

	[Type(20, "boolean")]
	public bool downed = default(bool);

	[Type(21, "number")]
	public float facingX = default(float);

	[Type(22, "number")]
	public float facingZ = default(float);

	[Type(23, "uint32")]
	public uint kills = default(uint);

	[Type(24, "uint32")]
	public uint xpGained = default(uint);

	[Type(25, "uint32")]
	public uint joinTick = default(uint);
}

}
