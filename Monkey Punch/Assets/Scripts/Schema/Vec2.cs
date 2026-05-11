using Colyseus.Schema;
#if UNITY_5_3_OR_NEWER
using UnityEngine.Scripting;
#endif

namespace MonkeyPunch.Wire {

public partial class Vec2 : Schema {
#if UNITY_5_3_OR_NEWER
[Preserve]
#endif
public Vec2() { }
	[Type(0, "number")]
	public float x = default(float);

	[Type(1, "number")]
	public float z = default(float);
}

}
