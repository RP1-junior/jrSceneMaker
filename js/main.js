// ===== Constants & Styles =====
const SNAP_STEP = 1;
const LABEL_SIZE = 0.2;
const LABEL_OFFSET = 0.5;
const HUMAN_HEIGHT = 1.75; // meters (5'9")
const BOX_COLORS = { hover:0x99ccff, selected:0x0000ff, editing:0xffffff };

// ===== Scene setup =====
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 1000);
camera.position.set(3,3,6);

const renderer = new THREE.WebGLRenderer({ antialias:true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const orbit = new THREE.OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

let groundSize = 20;
orbit.minDistance = 1;
orbit.maxDistance = groundSize * 1.5;

const transform = new THREE.TransformControls(camera, renderer.domElement);
transform.setSpace('local'); // Use local space for better rotation behavior
transform.setSize(0.8); // Slightly smaller gizmo for better visibility
scene.add(transform);

let selectedObject = null;
let selectedObjects = [];
let hoveredObject = null;
let draggedItem = null;
let draggedObject = null;
let draggedObjects = []; // Array to hold multiple dragged objects
let isAltPressed = false;
let isDuplicating = false;
let originalObject = null;

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
const dirLight = new THREE.DirectionalLight(0xffffff, 1);
dirLight.position.set(5,10,7);
scene.add(dirLight);

let grid = new THREE.GridHelper(groundSize, groundSize, 0x888888, 0x444444);
grid.userData.isSelectable = false;
grid.raycast = () => {};
scene.add(grid);

// Create Object Root as parent for all imported models
let canvasRoot = new THREE.Group();
canvasRoot.name = "Object Root";
canvasRoot.userData.isSelectable = true;
canvasRoot.userData.isCanvasRoot = true;
// Initialize aBound with current groundSize
canvasRoot.userData.aBound = [groundSize, groundSize, groundSize];
scene.add(canvasRoot);

let ruler = null;
let humanGuide = null;

// Human guide (reference only)
humanGuide = createHumanGuide(HUMAN_HEIGHT);
scene.add(humanGuide);


// ===== UI refs =====
const loader = new THREE.GLTFLoader();
const fileInput = document.getElementById("file");

// ===== Model Cache System =====
const modelCache = new Map(); // Cache for loaded models by URL/sReference
const loadingPromises = new Map(); // Track ongoing loading operations

// ===== URL and Model Loading Utilities =====
function isUrl(sReference) {
  return sReference && (sReference.startsWith('http://') || sReference.startsWith('https://'));
}

function getCacheKey(sReference) {
  // Use the sReference as the cache key for both URLs and local files
  return sReference || '';
}

async function loadModelFromReference(sReference, boundingBox = null) {
  const cacheKey = getCacheKey(sReference);
  
  // Return cached model if available
  if (modelCache.has(cacheKey)) {
    return modelCache.get(cacheKey);
  }
  
  // Return existing loading promise if already loading
  if (loadingPromises.has(cacheKey)) {
    return loadingPromises.get(cacheKey);
  }
  
  // Create new loading promise
  const loadingPromise = new Promise((resolve, reject) => {
    if (isUrl(sReference)) {
      // Load from URL
      loader.load(
        sReference,
        (gltf) => {
          const model = gltf.scene;
          modelCache.set(cacheKey, model);
          loadingPromises.delete(cacheKey);
          resolve(model);
        },
        undefined,
        (error) => {
          console.error(`Failed to load model from URL: ${sReference}`, error);
          loadingPromises.delete(cacheKey);
          reject(error);
        }
      );
    } else {
      // For non-URL references, create a placeholder
      // Use bounding box dimensions if available, otherwise default to 1x1x1
      const dimensions = boundingBox && Array.isArray(boundingBox) && boundingBox.length >= 3 
        ? boundingBox 
        : [1, 1, 1];
      
      const geometry = new THREE.BoxGeometry(dimensions[0], dimensions[1], dimensions[2]);
      // Translate geometry so local origin is at bottom center instead of center
      geometry.translate(0, dimensions[1] / 2, 0);
      const material = new THREE.MeshBasicMaterial({ color: 0x888888 });
      const placeholder = new THREE.Mesh(geometry, material);
      placeholder.name = sReference ? sReference.replace(/\.[^/.]+$/, "") : "Placeholder";
      
      modelCache.set(cacheKey, placeholder);
      loadingPromises.delete(cacheKey);
      resolve(placeholder);
    }
  });
  
  loadingPromises.set(cacheKey, loadingPromise);
  return loadingPromise;
}
const modelList = document.getElementById("modelList");
const propertiesPanel = document.getElementById("properties");
const snapCheckbox = document.getElementById("snap");
const canvasSizeInput = document.getElementById("canvasSize");
const btnTranslate = document.getElementById("translate");
const btnRotate = document.getElementById("rotate");
const btnScale = document.getElementById("scale");
const btnDelete = document.getElementById("delete");
const btnUndo = document.getElementById("undo");
const btnResetCamera = document.getElementById("resetCamera");
const jsonEditor = document.getElementById("jsonEditor");
const exportJson = document.getElementById("exportJson");
const applyChanges = document.getElementById("applyChanges");

let modelCounter = 1;

// Initialize canvas root in sidebar
addCanvasRootToList();
createBoxHelperFor(canvasRoot);

let loadedFont = null;
const fontLoader = new THREE.FontLoader();
fontLoader.load('https://threejs.org/examples/fonts/helvetiker_regular.typeface.json', font => {
  loadedFont = font;
  ruler = createRuler(groundSize, 1);
  addRulerLabels(ruler, groundSize, 1, loadedFont);
  ruler.userData.isSelectable = false;
  scene.add(ruler);
});

// ===== Utilities =====


// Function to check if an object would exceed the bounding box constraints
function wouldExceedBounds(obj) {
  // Get the object root's bounding box (aBound) for clamping constraints
  const rootBox = getBox(canvasRoot);
  const rootSize = rootBox.getSize(new THREE.Vector3());
  const rootCenter = rootBox.getCenter(new THREE.Vector3());
  
  // Calculate root bounds
  const rootMinX = rootCenter.x - rootSize.x/2;
  const rootMaxX = rootCenter.x + rootSize.x/2;
  const rootMinY = rootCenter.y - rootSize.y/2;
  const rootMaxY = rootCenter.y + rootSize.y/2;
  const rootMinZ = rootCenter.z - rootSize.z/2;
  const rootMaxZ = rootCenter.z + rootSize.z/2;
  
  // Get the object's current world bounding box
  const worldBox = new THREE.Box3().setFromObject(obj);
  const worldSize = worldBox.getSize(new THREE.Vector3());
  const worldCenter = worldBox.getCenter(new THREE.Vector3());
  
  const worldMinX = worldCenter.x - worldSize.x/2, worldMaxX = worldCenter.x + worldSize.x/2;
  const worldMinY = worldCenter.y - worldSize.y/2, worldMaxY = worldCenter.y + worldSize.y/2;
  const worldMinZ = worldCenter.z - worldSize.z/2, worldMaxZ = worldCenter.z + worldSize.z/2;
  
  // Check if any part of the object would exceed the bounds
  return (
    worldMinX < rootMinX || worldMaxX > rootMaxX ||
    worldMinY < rootMinY || worldMaxY > rootMaxY ||
    worldMinZ < rootMinZ || worldMaxZ > rootMaxZ
  );
}

// Store the last valid position for boundary enforcement
let lastValidPosition = null;
let lastValidQuaternion = null;
let lastValidScale = null;

function getBox(obj){ 
  // Special handling for Object Root - return bounding box based on aBound or fallback to groundSize
  if (obj.userData?.isCanvasRoot) {
    const box = new THREE.Box3();
    
    // Check if object root has aBound data stored
    let sizeX, sizeY, sizeZ;
    if (obj.userData?.aBound && Array.isArray(obj.userData.aBound) && obj.userData.aBound.length >= 3) {
      // Use stored aBound values
      sizeX = obj.userData.aBound[0];
      sizeY = obj.userData.aBound[1];
      sizeZ = obj.userData.aBound[2];
    } else {
      // Fallback to groundSize for backward compatibility
      sizeX = groundSize;
      sizeY = groundSize;
      sizeZ = groundSize;
    }
    
    box.setFromCenterAndSize(
      new THREE.Vector3(0, sizeY / 2, 0), // Center at half height
      new THREE.Vector3(sizeX, sizeY, sizeZ) // Use aBound dimensions
    );
    return box;
  }
  
  // Use JSON bounding box if available (for imported objects)
  if (obj.userData?.jsonBounds) {
    const box = new THREE.Box3();
    const center = obj.position.clone(); // Use local position
    box.setFromCenterAndSize(center, obj.userData.jsonBounds.size);
    return box;
  }
  
  return new THREE.Box3().setFromObject(obj); 
}

function getTriangleCount(obj){
  let triangleCount = 0;
  
  // Special handling for Object Root - show combined count of all children
  if (obj.userData?.isCanvasRoot) {
    obj.children.forEach(child => {
      triangleCount += getTriangleCount(child);
    });
    return triangleCount;
  }
  
  obj.traverse((child) => {
    if (child.isMesh && child.geometry) {
      const geometry = child.geometry;
      if (geometry.index) {
        // Indexed geometry
        triangleCount += geometry.index.count / 3;
      } else {
        // Non-indexed geometry
        triangleCount += geometry.attributes.position.count / 3;
      }
    }
  });
  
  return Math.floor(triangleCount);
}

function updateAllVisuals(obj){
  
  if(!obj) return;

  // Skip canvas clamping for objects imported from JSON (they should use exact local positions)
  if (!obj.userData?.isImportedFromJSON) {
    // Apply canvas clamp restrictions to any object being transformed (including nested objects)
    clampToCanvasRecursive(obj);
  } else {
  }

  updateModelProperties(obj);
  updatePropertiesPanel(obj);
  updateBoxHelper(obj);

  // If this is a group, also update child bounding boxes
  if (obj.userData?.isEditorGroup) {
    updateChildBoundingBoxes(obj);
  }

  // If this object is a child in a group, update the parent group's bounding box
  if (isChildObjectInGroup(obj) && obj.parent) {
    updateParentGroupBounds(obj.parent);
  }

  // Only add dimension labels for selected objects
  if(selectedObjects.includes(obj)) {
    addBoundingBoxDimensions(obj);
  }

  // Update JSON editor
  updateJSONEditorFromScene();
}

function updateParentGroupBounds(parentGroup) {
  if (!parentGroup || !parentGroup.userData?.isEditorGroup) return;

  // Update the parent group's box helper
  if (parentGroup.userData.boxHelper) {
    parentGroup.userData.boxHelper.update();
  }

  // Update the parent group's parent box helper (gray one)
  if (parentGroup.userData.parentBoxHelper) {
    parentGroup.userData.parentBoxHelper.update();
  }

  // Recursively update parent groups if this group is nested
  if (isChildObjectInGroup(parentGroup) && parentGroup.parent) {
    updateParentGroupBounds(parentGroup.parent);
  }
}

function cleanupObject(obj){
  if (!obj) return;
  if (obj.userData.boxHelper) {
    scene.remove(obj.userData.boxHelper);
    obj.userData.boxHelper.geometry?.dispose();
    obj.userData.boxHelper.material?.dispose();
    delete obj.userData.boxHelper;
  }
  if (obj.userData.parentBoxHelper) {
    scene.remove(obj.userData.parentBoxHelper);
    obj.userData.parentBoxHelper.geometry?.dispose();
    obj.userData.parentBoxHelper.material?.dispose();
    delete obj.userData.parentBoxHelper;
  }
  if (obj.userData.dimGroup) {
    scene.remove(obj.userData.dimGroup);
    obj.userData.dimGroup.traverse(c=>{
      c.geometry?.dispose();
      c.material?.dispose();
    });
    delete obj.userData.dimGroup;
  }
  if (obj.userData.listItem) {
    const li = obj.userData.listItem;
    const next = li.nextSibling;
    li.remove();
    if (next && next.tagName === "UL") next.remove();
    delete obj.userData.listItem;
  }
}

function snapUniformScale(obj, step=SNAP_STEP){
  const box = getBox(obj);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const snapped = Math.max(step, Math.round(maxDim/step)*step);
  if (maxDim > 0) obj.scale.multiplyScalar(snapped/maxDim);
}

function clampToCanvas(obj){
  
  // Get the object root's bounding box (aBound) for clamping constraints
  const rootBox = getBox(canvasRoot);
  const rootSize = rootBox.getSize(new THREE.Vector3());
  const rootCenter = rootBox.getCenter(new THREE.Vector3());
  
  // Calculate root bounds
  const rootMinX = rootCenter.x - rootSize.x/2;
  const rootMaxX = rootCenter.x + rootSize.x/2;
  const rootMinY = rootCenter.y - rootSize.y/2;
  const rootMaxY = rootCenter.y + rootSize.y/2;
  const rootMinZ = rootCenter.z - rootSize.z/2;
  const rootMaxZ = rootCenter.z + rootSize.z/2;
  
  // For nested objects, we need to work with world positions
  const worldBox = new THREE.Box3().setFromObject(obj);
  const worldSize = worldBox.getSize(new THREE.Vector3());
  const worldCenter = worldBox.getCenter(new THREE.Vector3());
  
  const worldMinX = worldCenter.x - worldSize.x/2, worldMaxX = worldCenter.x + worldSize.x/2;
  const worldMinY = worldCenter.y - worldSize.y/2, worldMaxY = worldCenter.y + worldSize.y/2;
  const worldMinZ = worldCenter.z - worldSize.z/2, worldMaxZ = worldCenter.z + worldSize.z/2;
  
  // Calculate adjustments needed
  let adjustmentX = 0, adjustmentY = 0, adjustmentZ = 0;
  
  // Clamp X axis
  if (worldMinX < rootMinX) {
    adjustmentX = rootMinX - worldMinX;
  }
  if (worldMaxX > rootMaxX) {
    adjustmentX = rootMaxX - worldMaxX;
  }
  
  // Clamp Y axis
  if (worldMinY < rootMinY) {
    adjustmentY = rootMinY - worldMinY;
  }
  if (worldMaxY > rootMaxY) {
    adjustmentY = rootMaxY - worldMaxY;
  }
  
  // Clamp Z axis
  if (worldMinZ < rootMinZ) {
    adjustmentZ = rootMinZ - worldMinZ;
  }
  if (worldMaxZ > rootMaxZ) {
    adjustmentZ = rootMaxZ - worldMaxZ;
  }
  
  // Apply adjustments
  if (adjustmentX !== 0 || adjustmentY !== 0 || adjustmentZ !== 0) {
    // For nested objects, we need to adjust the world position
    // by modifying the local position relative to the parent
    const worldAdjustment = new THREE.Vector3(adjustmentX, adjustmentY, adjustmentZ);
    
    if (obj.parent && obj.parent !== scene) {
      // Convert world adjustment to local adjustment
      const localAdjustment = worldAdjustment.clone();
      obj.parent.worldToLocal(localAdjustment);
      obj.position.add(localAdjustment);
    } else {
      // Direct world position adjustment for top-level objects
      obj.position.add(worldAdjustment);
    }
  }
  
}

function clampToCanvasRecursive(obj){
  
  // Always clamp the object itself, regardless of whether it's in a group or not
  // This ensures that ALL objects (including nested ones) respect the bounding box constraints
  clampToCanvas(obj);
  
  // If this is a group, also clamp all its children recursively
  if (obj.userData?.isEditorGroup) {
    obj.children.forEach(child => {
      if (child.userData?.isSelectable) {
        clampToCanvasRecursive(child);
      }
    });
  }
  
}

function findTopLevelGroup(obj) {
  // Find the top-level group in the hierarchy (the one directly attached to scene)
  let current = obj;
  while (current.parent && current.parent !== scene && current.parent.userData?.isEditorGroup) {
    current = current.parent;
  }
  return current;
}

// Function to extract texture resolution information from GLTF models
function getTextureResolutionInfo(model) {
  const textureInfo = {
    textures: [],
    totalTextures: 0,
    maxResolution: { width: 0, height: 0 },
    minResolution: { width: Infinity, height: Infinity }
  };

  if (!model) return textureInfo;

  // Traverse the model to find all materials and their textures
  model.traverse((child) => {
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      
      materials.forEach(material => {
        // Check various texture maps
        const textureMaps = [
          { name: 'map', texture: material.map },
          { name: 'normalMap', texture: material.normalMap },
          { name: 'roughnessMap', texture: material.roughnessMap },
          { name: 'metalnessMap', texture: material.metalnessMap },
          { name: 'emissiveMap', texture: material.emissiveMap },
          { name: 'aoMap', texture: material.aoMap },
          { name: 'displacementMap', texture: material.displacementMap },
          { name: 'alphaMap', texture: material.alphaMap },
          { name: 'lightMap', texture: material.lightMap },
          { name: 'bumpMap', texture: material.bumpMap },
          { name: 'envMap', texture: material.envMap }
        ];

        textureMaps.forEach(({ name, texture }) => {
          if (texture && texture.image) {
            const width = texture.image.width || texture.image.videoWidth || 0;
            const height = texture.image.height || texture.image.videoHeight || 0;
            
            if (width > 0 && height > 0) {
              textureInfo.textures.push({
                type: name,
                width: width,
                height: height,
                resolution: `${width}x${height}`,
                materialName: material.name || 'Unnamed Material'
              });
              
              textureInfo.totalTextures++;
              
              // Update max resolution
              if (width > textureInfo.maxResolution.width || height > textureInfo.maxResolution.height) {
                textureInfo.maxResolution.width = Math.max(textureInfo.maxResolution.width, width);
                textureInfo.maxResolution.height = Math.max(textureInfo.maxResolution.height, height);
              }
              
              // Update min resolution
              if (width < textureInfo.minResolution.width || height < textureInfo.minResolution.height) {
                textureInfo.minResolution.width = Math.min(textureInfo.minResolution.width, width);
                textureInfo.minResolution.height = Math.min(textureInfo.minResolution.height, height);
              }
            }
          }
        });
      });
    }
  });

  // Reset min resolution if no textures found
  if (textureInfo.totalTextures === 0) {
    textureInfo.minResolution = { width: 0, height: 0 };
  }

  return textureInfo;
}

function updateModelProperties(model){
  if(!model) return;
  
  // Special handling for Object Root - use canvas dimensions
  if (model.userData?.isCanvasRoot) {
    const canvasSize = new THREE.Vector3(groundSize, groundSize, groundSize);
    const worldPosition = new THREE.Vector3(0, groundSize / 2, 0); // Canvas center (matches canvas box helper)
    const worldScale = new THREE.Vector3(1, 1, 1); // No scaling for canvas
    const worldQuaternion = new THREE.Quaternion(0, 0, 0, 1); // Identity quaternion for canvas

    // Calculate triangle count
    const triangleCount = getTriangleCount(model);

    // Get texture resolution information
    const textureInfo = getTextureResolutionInfo(model);

    // Store aBound data for clamping constraints
    model.userData.aBound = [groundSize, groundSize, groundSize];

    model.userData.properties = {
      pos: worldPosition,
      scl: worldScale,
      rot: worldQuaternion.clone(),
      size: canvasSize.clone(),
      triangles: triangleCount,
      textures: textureInfo
    };
    return;
  }
  
  const box = getBox(model);
  const size = box.getSize(new THREE.Vector3());

  // Use local transforms for consistent local positioning
  const localPosition = model.position.clone();
  const localScale = model.scale.clone();
  const localQuaternion = model.quaternion.clone();

  // Calculate triangle count
  const triangleCount = getTriangleCount(model);

  // Get texture resolution information
  const textureInfo = getTextureResolutionInfo(model);

  model.userData.properties = {
    pos: localPosition,
    scl: localScale,
    rot: localQuaternion.clone(),
    size: size.clone(),
    triangles: triangleCount,
    textures: textureInfo
  };
}

function updatePropertiesPanel(model){
  if(!model || !model.userData.properties){
    propertiesPanel.textContent = "";
    return;
  }
  const p = model.userData.properties;
  let propertiesText = 
    `Position: (${p.pos.x.toFixed(2)}, ${p.pos.y.toFixed(2)}, ${p.pos.z.toFixed(2)})\n`+
    `Rotation: (${p.rot.x.toFixed(4)}, ${p.rot.y.toFixed(4)}, ${p.rot.z.toFixed(4)}, ${p.rot.w.toFixed(4)})\n`+
    `Scale: (${p.scl.x.toFixed(2)}, ${p.scl.y.toFixed(2)}, ${p.scl.z.toFixed(2)})\n`+
    `Bounds: (${p.size.x.toFixed(2)}, ${p.size.y.toFixed(2)}, ${p.size.z.toFixed(2)})\n`+
    `Triangles: ${p.triangles.toLocaleString()}`;

  // Add concise texture information
  if (p.textures && p.textures.totalTextures > 0) {
    if (p.textures.maxResolution.width === p.textures.minResolution.width) {
      // All textures same resolution
      propertiesText += `\nTextures: ${p.textures.totalTextures} @ ${p.textures.maxResolution.width}x${p.textures.maxResolution.height}`;
    } else {
      // Mixed resolutions
      propertiesText += `\nTextures: ${p.textures.totalTextures} (${p.textures.minResolution.width}x${p.textures.minResolution.height} - ${p.textures.maxResolution.width}x${p.textures.maxResolution.height})`;
    }
  } else {
    propertiesText += `\nTextures: None`;
  }

  propertiesPanel.textContent = propertiesText;
}

function updateTransformButtonStates(){
  const editingAllowed = isEditingAllowed();
  const buttons = [btnTranslate, btnRotate, btnScale];

  buttons.forEach(btn => {
    if (editingAllowed) {
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    } else {
      btn.disabled = true;
      btn.style.opacity = "0.5";
      btn.style.cursor = "not-allowed";
    }
  });

  // Handle delete button - disable if only Object Root is selected
  const deleteAllowed = selectedObjects.length > 0 && !(selectedObjects.length === 1 && selectedObjects[0].userData?.isCanvasRoot);
  if (deleteAllowed) {
    btnDelete.disabled = false;
    btnDelete.style.opacity = "1";
    btnDelete.style.cursor = "pointer";
  } else {
    btnDelete.disabled = true;
    btnDelete.style.opacity = "0.5";
    btnDelete.style.cursor = "not-allowed";
  }

  // Detach transform gizmo if editing is not allowed
  if (!editingAllowed) {
    transform.detach();
  } else if (selectedObject) {
    // Reattach to the selected object if editing is allowed
    transform.attach(selectedObject);
  }
}

function createBoxHelperFor(model){
  if (model.userData?.isCanvasRoot) {
    // Create special canvas bounding box
    createCanvasBoxHelper(model);
  } else {
    const helper = new THREE.BoxHelper(model, BOX_COLORS.selected);
    helper.material.transparent = true;
    helper.material.opacity = 0.9;
    helper.visible = false;
    model.userData.boxHelper = helper;
    scene.add(helper);
  }
}

function createCanvasBoxHelper(canvasRoot){
  // Create a bounding box that represents the canvas size from surface up
  const halfSize = groundSize / 2;
  const height = groundSize; // Canvas height from surface up
  
  const geometry = new THREE.BoxGeometry(groundSize, height, groundSize);
  const edges = new THREE.EdgesGeometry(geometry);
  const material = new THREE.LineBasicMaterial({ 
    color: BOX_COLORS.selected,
    transparent: true,
    opacity: 0.9
  });
  
  const helper = new THREE.LineSegments(edges, material);
  helper.position.set(0, height / 2, 0); // Position from surface up
  helper.visible = false;
  
  canvasRoot.userData.boxHelper = helper;
  scene.add(helper);
}

function updateBoxHelper(model, color=null){
  if (!model?.userData.boxHelper) return;
  
  if (model.userData?.isCanvasRoot) {
    // For canvas root, update the canvas box helper size
    updateCanvasBoxHelper(model, color);
  } else {
    model.userData.boxHelper.update();
    if (color) model.userData.boxHelper.material.color.setHex(color);
  }
}

function updateCanvasBoxHelper(canvasRoot, color=null){
  if (!canvasRoot?.userData.boxHelper) return;
  
  // Update the canvas box helper size based on current ground size
  const halfSize = groundSize / 2;
  const height = groundSize;
  
  // Update geometry
  const geometry = new THREE.BoxGeometry(groundSize, height, groundSize);
  const edges = new THREE.EdgesGeometry(geometry);
  canvasRoot.userData.boxHelper.geometry.dispose();
  canvasRoot.userData.boxHelper.geometry = edges;
  
  // Update position
  canvasRoot.userData.boxHelper.position.set(0, height / 2, 0);
  
  // Update color if provided
  if (color) canvasRoot.userData.boxHelper.material.color.setHex(color);
}

function setHelperVisible(model, visible){
  if(model?.userData.boxHelper) model.userData.boxHelper.visible = !!visible;
}

function createParentBoxHelperFor(parentGroup){
  if (!parentGroup || parentGroup.userData.parentBoxHelper) return;
  const helper = new THREE.BoxHelper(parentGroup, 0x888888); // Gray color for parent
  helper.material.transparent = true;
  helper.material.opacity = 0.5;
  helper.visible = false;
  parentGroup.userData.parentBoxHelper = helper;
  scene.add(helper);
}

function updateParentBoxHelper(parentGroup, color=null){
  if (!parentGroup?.userData.parentBoxHelper) return;
  parentGroup.userData.parentBoxHelper.update();
  if (color) parentGroup.userData.parentBoxHelper.material.color.setHex(color);
}

function setParentHelperVisible(parentGroup, visible){
  if(parentGroup?.userData.parentBoxHelper) parentGroup.userData.parentBoxHelper.visible = !!visible;
}

function showChildBoundingBoxes(group, visible, color = 0x888888, recursive = true){
  if (!group || !group.userData?.isEditorGroup) return;

  group.children.forEach(child => {
    // Ensure child has a box helper
    if (!child.userData.boxHelper) {
      createBoxHelperFor(child);
    }

    if (visible) {
      child.userData.boxHelper.visible = true;
      child.userData.boxHelper.material.color.setHex(color);
      child.userData.boxHelper.material.opacity = 0.5; // Semi-transparent for child boxes
    } else {
      child.userData.boxHelper.visible = false;
    }

    // Recursively handle nested groups
    if (recursive && child.userData?.isEditorGroup) {
      showChildBoundingBoxes(child, visible, color, recursive);
    }
  });
}

function updateChildBoundingBoxes(group, recursive = true){
  if (!group || !group.userData?.isEditorGroup) return;

  group.children.forEach(child => {
    if (child.userData.boxHelper) {
      child.userData.boxHelper.update();
    }

    // Recursively handle nested groups
    if (recursive && child.userData?.isEditorGroup) {
      updateChildBoundingBoxes(child, recursive);
    }
  });
}

function showObjectRootChildrenBoundingBoxes(objectRoot, visible, color = 0x666666, opacity = 0.3){
  if (!objectRoot || !objectRoot.userData?.isCanvasRoot) return;

  objectRoot.children.forEach(child => {
    // Ensure child has a box helper
    if (!child.userData.boxHelper) {
      createBoxHelperFor(child);
    }

    if (visible) {
      child.userData.boxHelper.visible = true;
      child.userData.boxHelper.material.color.setHex(color);
      child.userData.boxHelper.material.opacity = opacity;
    } else {
      child.userData.boxHelper.visible = false;
    }

    // Recursively handle nested groups
    if (child.userData?.isEditorGroup) {
      showChildBoundingBoxes(child, visible, color, true);
    }
  });
}

function addBoundingBoxDimensions(model){
  if(!loadedFont) return;
  if(model.userData.dimGroup){
    scene.remove(model.userData.dimGroup);
    model.userData.dimGroup.traverse(c=>{
      c.geometry?.dispose();
      c.material?.dispose();
    });
  }
  const box = getBox(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({color:0xffff00});
  const label = (text,pos)=>{
    const mesh = new THREE.Mesh(
      new THREE.TextGeometry(text,{font:loadedFont,size:LABEL_SIZE,height:0}),
      mat
    );
    mesh.position.copy(pos);
    group.add(mesh);
  };
  label(`${size.x.toFixed(2)}m`, new THREE.Vector3(center.x, box.max.y+0.2, box.min.z-LABEL_OFFSET));
  label(`${size.y.toFixed(2)}m`, new THREE.Vector3(box.max.x+LABEL_OFFSET, center.y, box.min.z-LABEL_OFFSET));
  label(`${size.z.toFixed(2)}m`, new THREE.Vector3(center.x, box.min.y-LABEL_OFFSET, box.max.z+LABEL_OFFSET));
  scene.add(group);
  model.userData.dimGroup = group;
}


// ===== Transforms: initial & helpers =====
function storeInitialTransform(obj){
  obj.userData.initialTransform = {
    pos: obj.position.clone(),
    rot: obj.quaternion.clone(),
    scale: obj.scale.clone()
  };
}

function resetTransform(obj){
  if(!obj.userData.initialTransform) return;
  const t = obj.userData.initialTransform;
  obj.position.copy(t.pos);
  obj.quaternion.copy(t.rot);
  obj.scale.copy(t.scale);
  updateAllVisuals(obj);
}

function dropToFloor(obj){
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  obj.position.y -= box.min.y;
  updateAllVisuals(obj);
}

// ===== Selection validation helpers =====
function isEditingAllowed(){
  // No editing if no objects selected
  if (selectedObjects.length === 0) return false;

  // Single object selected
  if (selectedObjects.length === 1) {
    const obj = selectedObjects[0];

    // Prevent editing canvas root
    if (obj.userData?.isCanvasRoot) return false;

    // If it's a child object in a group, only allow editing if selected from sidebar
    if (isChildObjectInGroup(obj)) {
      return isChildObjectSelectedFromSidebar(obj);
    }

    // Otherwise, always allow editing
    return true;
  }

  // Multiple objects selected - transforms are disabled
  // Users can still delete or duplicate, but not transform
  if (selectedObjects.length > 1) {
    return false;
  }

  return false;
}

function isChildObjectInGroup(obj){
  return obj.parent && obj.parent.userData?.isEditorGroup === true;
}

function isChildObjectSelectedFromSidebar(obj){
  // Check if this object is a child of a group and was selected from sidebar
  if (!isChildObjectInGroup(obj)) return false;

  // Check if the object has a list item that's nested under a group
  const listItem = obj.userData?.listItem;
  if (!listItem) return false;

  // Check if this list item is nested under a group's child list
  const parentLi = listItem.parentElement;
  if (!parentLi || parentLi.tagName !== 'UL') return false;

  const groupLi = parentLi.previousElementSibling;
  if (!groupLi || !groupLi.querySelector('.caret')) return false;

  return true;
}

// ===== Selection (unified) =====
function selectObject(obj, additive=false, toggle=false){
  if (!additive && !toggle) {
    selectedObjects.forEach(o=>{
      o.userData.listItem?.classList.remove("selected");
      setHelperVisible(o,false);
      // Hide parent box helper if object is a child in a group
      if (isChildObjectInGroup(o) && o.parent) {
        setParentHelperVisible(o.parent, false);
      }
      // Hide child bounding boxes if object is a group
      if (o.userData?.isEditorGroup) {
        showChildBoundingBoxes(o, false);
      }
      // Hide Object Root children bounding boxes
      if (o.userData?.isCanvasRoot) {
        showObjectRootChildrenBoundingBoxes(o, false);
      }
      if (o.userData.dimGroup) scene.remove(o.userData.dimGroup);
    });
    selectedObjects = [];
    updateTransformButtonStates();
  }

  if (toggle && selectedObjects.includes(obj)) {
    selectedObjects = selectedObjects.filter(o=>o!==obj);
    obj.userData.listItem?.classList.remove("selected");
    setHelperVisible(obj,false);
    // Hide parent box helper if object is a child in a group
    if (isChildObjectInGroup(obj) && obj.parent) {
      setParentHelperVisible(obj.parent, false);
    }
    // Hide child bounding boxes if object is a group
    if (obj.userData?.isEditorGroup) {
      showChildBoundingBoxes(obj, false);
    }
    // Hide Object Root children bounding boxes
    if (obj.userData?.isCanvasRoot) {
      showObjectRootChildrenBoundingBoxes(obj, false);
    }
    updatePropertiesPanel(selectedObjects[selectedObjects.length-1] || null);
    updateTransformButtonStates();
    return;
  }

  if (!selectedObjects.includes(obj)) selectedObjects.push(obj);
  selectedObject = obj;

  obj.userData.listItem?.classList.add("selected");

  // Ensure the object has a box helper
  if (!obj.userData.boxHelper) {
    createBoxHelperFor(obj);
  }

  setHelperVisible(obj,true);
  updateBoxHelper(obj, BOX_COLORS.selected);

  // If this is a child object in a group, also show the parent group's bounding box
  if (isChildObjectInGroup(obj) && obj.parent) {
    const parentGroup = obj.parent;
    // Create parent box helper if it doesn't exist
    if (!parentGroup.userData.parentBoxHelper) {
      createParentBoxHelperFor(parentGroup);
    }
    setParentHelperVisible(parentGroup, true);
    updateParentBoxHelper(parentGroup, 0x888888); // Gray color for parent
  }

  // If this is a parent group, show child bounding boxes in gray
  if (obj.userData?.isEditorGroup) {
    showChildBoundingBoxes(obj, true, 0x888888); // Gray color for children
  }

  // If this is Object Root, show all children bounding boxes lightly
  if (obj.userData?.isCanvasRoot) {
    showObjectRootChildrenBoundingBoxes(obj, true);
  }

  addBoundingBoxDimensions(obj);
  updateModelProperties(obj);
  updatePropertiesPanel(obj);
  updateTransformButtonStates();
}

function selectFromSidebar(obj, li, e){
  const additive = !!(e && (e.shiftKey||e.ctrlKey||e.metaKey));
  const toggle = !!(e && (e.ctrlKey||e.metaKey));
  selectObject(obj, additive, toggle);
}

function selectFromCanvas(obj, additive){
  selectObject(obj, !!additive, false);
}

// ===== Sidebar (DRY creation) =====
function createSidebarItem(obj, name, isGroup=false, parentList=null){
  const li = document.createElement("li");
  let caret = null;
  const label = document.createElement("span");
  label.textContent = name;

  // Make list item draggable
  li.draggable = true;
  li.setAttribute('data-object-id', obj.uuid);

  if (isGroup) {
    caret = document.createElement("span");
    caret.className = "caret";
    caret.title = "Toggle children";
    caret.addEventListener("click", e=>{
      e.stopPropagation();
      // Prevent toggling Object Root
      if (obj.userData?.isCanvasRoot) {
        return; // Object Root should always stay expanded
      }
      setGroupExpanded(li, !(caret.classList.contains("expanded")));
    });
    li.appendChild(caret);
  }

  li.appendChild(label);

  li.onclick = e => selectFromSidebar(obj, li, e);
  li.ondblclick = e => {
    if (e.target === label) makeLabelEditable(label, obj);
    else { 
      selectFromSidebar(obj, li, e); 
      // Special handling for Object Root - reset camera to canvas view
      if (obj.userData?.isCanvasRoot) {
        resetCamera();
      } else {
        frameCameraOn(obj); 
      }
    }
  };

  // Drag and drop event handlers
  li.addEventListener('dragstart', handleDragStart);
  li.addEventListener('dragend', handleDragEnd);
  li.addEventListener('dragover', handleDragOver);
  li.addEventListener('dragenter', handleDragEnter);
  li.addEventListener('dragleave', handleDragLeave);
  li.addEventListener('drop', handleDrop);

  obj.userData.listItem = li;
  const targetList = parentList || modelList;
  targetList.appendChild(li);

  if (isGroup) {
    const childList = ensureChildList(li);
    // Expand all hierarchies by default
    caret?.classList.add("expanded");
    childList.classList.remove("children-collapsed");
    childList.style.display = "block";
  }
}


function addGroupToList(group, name, parentList = null){
  const targetList = parentList || modelList;
  // If no parent list specified, add to canvas root's child list
  if (!parentList) {
    const canvasChildList = canvasRoot.userData.listItem.nextSibling;
    createSidebarItem(group, name, true, canvasChildList);
  } else {
    createSidebarItem(group, name, true, targetList);
  }
  group.userData.listType = "group";
  const childList = group.userData.listItem.nextSibling;

  // Skip the first child (parent object) and only show other children
  const childrenToShow = group.children.slice(1);
  childrenToShow.forEach(child=>{
    if (child.userData?.isEditorGroup) {
      // This is a nested group - add it recursively
      addGroupToList(child, child.name || "Attached", childList);
    } else {
      // This is a regular model - add it as a child item
      addModelToList(child, child.name || "Model", childList);
    }
  });
}

function addCanvasRootToList(){
  createSidebarItem(canvasRoot, canvasRoot.name, true, modelList);
  canvasRoot.userData.listType = "canvas";
  const childList = canvasRoot.userData.listItem.nextSibling;
  
  // Object Root should always be expanded and cannot be collapsed
  const caret = canvasRoot.userData.listItem.querySelector(".caret");
  if (caret) {
    caret.classList.add("expanded");
    caret.style.pointerEvents = "none"; // Disable clicking
    caret.style.opacity = "0.5"; // Visual indication it's disabled
  }
  
  // Ensure child list is always visible
  childList.classList.remove("children-collapsed");
  childList.style.display = "block";
}

function addModelToList(model, name, parentList = null){
  const targetList = parentList || modelList;
  // If no parent list specified, add to canvas root's child list
  if (!parentList) {
    const canvasChildList = canvasRoot.userData.listItem.nextSibling;
    createSidebarItem(model, name, false, canvasChildList);
  } else {
    createSidebarItem(model, name, false, targetList);
  }
  model.userData.listType = "model";
}

function rebuildGroupSidebar(group) {
  if (!group || !group.userData?.isEditorGroup) return;

  // Remove existing child list items
  const groupLi = group.userData.listItem;
  if (!groupLi) return;

  const childList = groupLi.nextSibling;
  if (childList && childList.tagName === "UL") {
    // Clear all child items
    while (childList.firstChild) {
      childList.removeChild(childList.firstChild);
    }

    // Skip the first child (parent object) and only show other children
    const childrenToShow = group.children.slice(1);
    childrenToShow.forEach(child => {
      if (child.userData?.isEditorGroup) {
        // This is a nested group - add it recursively
        addGroupToList(child, child.name || "Attached", childList);
      } else {
        // This is a regular model - add it as a child item
        addModelToList(child, child.name || "Model", childList);
      }
    });
  }
}

function ensureChildList(li){
  let childList = li.nextSibling;
  if (!(childList && childList.tagName === "UL")) {
    childList = document.createElement("ul");
    childList.style.listStyle = "none";
    childList.style.paddingLeft = "12px";
    childList.style.margin = "4px 0 6px 0";
    li.after(childList);
  }
  return childList;
}

function setGroupExpanded(li, expanded){
  const caret = li.querySelector(".caret");
  const childList = ensureChildList(li);
  
  // Prevent collapsing Object Root
  const obj = findObjectByListItem(li);
  if (obj && obj.userData?.isCanvasRoot) {
    // Object Root should always be expanded
    caret?.classList.add("expanded");
    childList.classList.remove("children-collapsed");
    childList.style.display = "block";
    return;
  }
  
  if (expanded) {
    caret?.classList.add("expanded");
    childList.classList.remove("children-collapsed");
    childList.style.display = "block";
  } else {
    caret?.classList.remove("expanded");
    childList.classList.add("children-collapsed");
    childList.style.display = "none";
  }
}

// ===== Inline renaming =====
function makeLabelEditable(label, obj){
  const input = document.createElement("input");
  input.type = "text";
  input.value = label.textContent;
  input.style.width = "80%";

  label.replaceWith(input);
  input.focus();

  const finish = () => {
    obj.name = (input.value.trim() || obj.name || "Unnamed");
    const newLabel = document.createElement("span");
    newLabel.textContent = obj.name;
    newLabel.ondblclick = () => makeLabelEditable(newLabel, obj);
    input.replaceWith(newLabel);
    obj.userData.listItem.firstChild = newLabel;
    
    // Update JSON editor when object name changes
    updateJSONEditorFromScene();
  };
  input.addEventListener("blur", finish);
  input.addEventListener("keydown", e=>{
    if (e.key === "Enter") finish();
    if (e.key === "Escape") { input.value = obj.name; finish(); }
  });
}

function renameSelectedObject(){
  if (selectedObjects.length !== 1) return;
  const li = selectedObjects[0].userData.listItem;
  const label = li?.querySelector("span");
  if (label) makeLabelEditable(label, selectedObjects[0]);
}


// ===== Ruler =====
function createRuler(size, step=1){
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({color:0xaaaaaa});
  for(let i=-size/2;i<=size/2;i+=step){
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(i,0,-size/2),new THREE.Vector3(i,0.1,-size/2)]), mat));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(i,0,size/2),new THREE.Vector3(i,0.1,size/2)]), mat));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-size/2,0,i),new THREE.Vector3(-size/2,0.1,i)]), mat));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(size/2,0,i),new THREE.Vector3(size/2,0.1,i)]), mat));
  }
  return group;
}

function addRulerLabels(group, size, step, font){
  const mat = new THREE.MeshBasicMaterial({color:0xaaaaaa});
  for(let i=-size/2;i<=size/2;i+=step){
    if(i===0) continue;
    const labelX = new THREE.Mesh(new THREE.TextGeometry(`${i}m`,{font,size:LABEL_SIZE,height:0}), mat);
    labelX.position.set(i,0.1,-size/2-LABEL_OFFSET);
    group.add(labelX);

    const labelZ = new THREE.Mesh(new THREE.TextGeometry(`${i}m`,{font,size:LABEL_SIZE,height:0}), mat);
    labelZ.position.set(-size/2-LABEL_OFFSET,0.1,i);
    group.add(labelZ);
  }
}

// ===== Human height guide (5'9" ≈ 1.75m) =====
function createHumanGuide(heightMeters=HUMAN_HEIGHT){
  const group = new THREE.Group();
  const color = 0x66aaff; // subtle bluish
  const opacity = 0.25;
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });

  // Proportions
  const headRadius = Math.min(0.09, heightMeters * 0.062);
  const legHeight = heightMeters * 0.50;
  const torsoHeight = heightMeters * 0.45;
  const shoulderWidth = heightMeters * 0.28;
  const waistWidth = heightMeters * 0.18;
  const limbWidth = Math.max(0.02, heightMeters * 0.06);
  const armLength = torsoHeight * 0.9;

  // Torso
  const torsoTop = new THREE.Mesh(new THREE.PlaneGeometry(shoulderWidth, torsoHeight * 0.55), mat);
  torsoTop.position.y = legHeight + (torsoHeight * 0.75);
  const torsoBottom = new THREE.Mesh(new THREE.PlaneGeometry(waistWidth, torsoHeight * 0.45), mat);
  torsoBottom.position.y = legHeight + (torsoHeight * 0.275);

  // Legs
  const legGeo = new THREE.PlaneGeometry(limbWidth, legHeight);
  const legL = new THREE.Mesh(legGeo, mat);
  legL.position.set(-waistWidth * 0.25, legHeight * 0.5, 0);
  const legR = new THREE.Mesh(legGeo.clone(), mat);
  legR.position.set(waistWidth * 0.25, legHeight * 0.5, 0);

  // Arms
  const armGeo = new THREE.PlaneGeometry(limbWidth, armLength);
  const armL = new THREE.Mesh(armGeo, mat);
  armL.position.set(-shoulderWidth * 0.5, legHeight + torsoHeight - armLength * 0.5, 0);
  const armR = new THREE.Mesh(armGeo.clone(), mat);
  armR.position.set(shoulderWidth * 0.5, legHeight + torsoHeight - armLength * 0.5, 0);

  // Head
  const head = new THREE.Mesh(new THREE.CircleGeometry(headRadius, 24), mat);
  head.position.y = legHeight + torsoHeight + headRadius * 1.05;

  // Crossed for visibility
  const axisGroupA = new THREE.Group();
  axisGroupA.add(torsoTop, torsoBottom, legL, legR, armL, armR, head);
  const axisGroupB = axisGroupA.clone();
  axisGroupB.traverse(node=>{ if (node.isMesh) node.geometry = node.geometry.clone(); });
  axisGroupB.rotation.y = Math.PI / 2;

  group.add(axisGroupA, axisGroupB);

  // Non-interactive
  group.userData.isSelectable = false;
  group.traverse(o=>{ o.userData.isSelectable = false; o.raycast = () => {}; });
  group.name = "HumanGuide";
  return group;
}


// ===== File loading (preserve original pivot & transform) =====
fileInput.addEventListener("change", async e=>{
  const file = e.target.files[0]; if(!file) return;
  const url = URL.createObjectURL(file);
  
  try {
    const gltf = await new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    });
    
    const model = gltf.scene;
    model.userData.isSelectable = true;
    model.name = (file.name || ("Model "+modelCounter++)).replace(/\.[^/.]+$/, "");
    
    // Track original source for export/reference reuse
    const reference = model.name + ".glb";
    model.userData.sourceRef = {
      originalFileName: file.name,
      baseName: model.name,
      reference: reference
    };
    
    // Cache the model for potential reuse
    modelCache.set(reference, model);
    
    createBoxHelperFor(model);

    canvasRoot.add(model);

    addModelToList(model, model.name);
    storeInitialTransform(model);
    selectObject(model);
    updateBoxHelper(model);
    frameCameraOn(model);
    saveState();
    updateJSONEditorFromScene();
  } catch (error) {
    console.error("Failed to load file:", error);
  } finally {
    // Clean up the object URL
    URL.revokeObjectURL(url);
  }
});

// ===== Attach / Detach =====
// DEPRECATED: Use drag-and-drop attaching instead
function groupSelectedObjects(){
  if (selectedObjects.length < 2) return;

  // Use the first (top-most) selected object as the parent group
  const parentObj = selectedObjects[0];
  const otherObjects = selectedObjects.slice(1);

  // Convert the parent object to a group
  const group = new THREE.Group();
  group.userData.isSelectable = true;
  group.userData.isEditorGroup = true;
  group.name = parentObj.name || "Attached " + Date.now();

  // Store parent object's world transform to preserve visual position
  const parentWorldPosition = new THREE.Vector3();
  const parentWorldQuaternion = new THREE.Quaternion();
  const parentWorldScale = new THREE.Vector3();
  parentObj.getWorldPosition(parentWorldPosition);
  parentObj.getWorldQuaternion(parentWorldQuaternion);
  parentObj.getWorldScale(parentWorldScale);

  // Copy parent object's transform to the group
  group.position.copy(parentObj.position);
  group.quaternion.copy(parentObj.quaternion);
  group.scale.copy(parentObj.scale);

  // Remove parent object from scene and add it as first child of group
  scene.remove(parentObj);
  group.add(parentObj);

  // Calculate local transform to preserve parent object's world position
  scene.updateMatrixWorld(true);
  const groupWorldMatrix = new THREE.Matrix4();
  group.updateMatrixWorld(true);
  groupWorldMatrix.copy(group.matrixWorld);

  const parentWorldMatrix = new THREE.Matrix4();
  parentWorldMatrix.compose(parentWorldPosition, parentWorldQuaternion, parentWorldScale);

  const localMatrix = new THREE.Matrix4();
  localMatrix.copy(groupWorldMatrix).invert().multiply(parentWorldMatrix);

  const localPosition = new THREE.Vector3();
  const localQuaternion = new THREE.Quaternion();
  const localScale = new THREE.Vector3();
  localMatrix.decompose(localPosition, localQuaternion, localScale);

  // Apply calculated local transform to preserve visual position
  parentObj.position.copy(localPosition);
  parentObj.quaternion.copy(localQuaternion);
  parentObj.scale.copy(localScale);

  // Clean up parent object's sidebar representation
  if (parentObj.userData.listItem) {
    const li = parentObj.userData.listItem;
    const next = li.nextSibling;
    li.remove();
    if(next && next.tagName==="UL") next.remove();
    delete parentObj.userData.listItem;
  }

  // Add other objects to the group
  otherObjects.forEach(obj=>{
    // Remember how this object appeared in the sidebar before grouping
    if (!obj.userData) obj.userData = {};
    obj.userData.originalListType = obj.userData.listType || (obj instanceof THREE.Group ? "group" : "model");
    obj.userData.originalName = obj.name;
    if(obj.userData.boxHelper){ scene.remove(obj.userData.boxHelper); delete obj.userData.boxHelper; }
    if(obj.userData.dimGroup){ scene.remove(obj.userData.dimGroup); delete obj.userData.dimGroup; }
    group.attach(obj);
    if (obj.userData.listItem) {
      const li = obj.userData.listItem;
      const next = li.nextSibling;
      li.remove();
      if(next && next.tagName==="UL") next.remove();
      delete obj.userData.listItem;
    }
  });

  canvasRoot.add(group);
  createBoxHelperFor(group);
  createParentBoxHelperFor(group);
  addGroupToList(group, group.name);
  storeInitialTransform(group);
  selectObject(group);
  updateAllVisuals(group);
}

function ungroupSelectedObject(){
  if (selectedObjects.length !== 1) return;
  let group = selectedObjects[0];

  // If the selected object is a child in a group (not the group itself), dissolve the parent group
  if (isChildObjectInGroup(group)) {
    group = group.parent;
  }

  if (!(group instanceof THREE.Group)) return;
  if (!group.userData || group.userData.isEditorGroup !== true) return;

  // Hide child bounding boxes before detaching
  showChildBoundingBoxes(group, false);

  // Remember the group's parent (could be scene or another group)
  const groupParent = group.parent || scene;
  const wasInParentGroup = groupParent && groupParent !== scene && groupParent.userData?.isEditorGroup;

  while (group.children.length > 0) {
    const child = group.children[0];

    // Move child to the group's parent (preserving local transform)
    if (groupParent === scene) {
      canvasRoot.attach(child);
    } else {
      groupParent.attach(child);
    }

    createBoxHelperFor(child);
    // Hide the child's bounding box after detaching
    setHelperVisible(child, false);

    // Restore original sidebar representation and label
    if (child.userData?.originalName) child.name = child.userData.originalName;
    const listType = child.userData?.originalListType || child.userData?.listType || (child instanceof THREE.Group ? "group" : "model");

    // Sidebar will be rebuilt below if we're in a parent group
    // Otherwise add to root of sidebar
    if (!wasInParentGroup) {
      if (listType === "group") addGroupToList(child, child.name || "Attached");
      else addModelToList(child, child.name || "Model");
    }

    delete child.userData?.originalListType;
    delete child.userData?.originalName;

    // Update visuals without clamping to preserve local positions during detaching
    updateModelProperties(child);
    updatePropertiesPanel(child);
    updateBoxHelper(child);

    // If this is a group, also update child bounding boxes
    if (child.userData?.isEditorGroup) {
      updateChildBoundingBoxes(child);
    }
  }

  // Clean up the group
  cleanupObject(group);
  if (group.parent) {
    group.parent.remove(group);
  } else {
    scene.remove(group);
  }

  // If the group was inside another group, rebuild that parent's sidebar
  if (wasInParentGroup) {
    rebuildGroupSidebar(groupParent);
  }

  selectedObjects = [];
  selectedObject = null;
  transform.detach();
  updatePropertiesPanel(null);
  updateJSONEditorFromScene();
}

function detachFromGroup(obj, skipSelection = false){
  if (!obj) return false;
  
  // Check if object is a child in a group
  if (!isChildObjectInGroup(obj)) return false;
  
  const parentGroup = obj.parent;
  
  // Only allow detaching if there are at least 2 non-parent children
  // (total children >= 3: parent + at least 2 other children)
  if (parentGroup.children.length < 3) {
    console.warn("Cannot detach: group must have at least 2 non-parent children. Use 'Detach' to dissolve the group instead.");
    return false;
  }
  
  // Hide parent box helper
  if (parentGroup.userData.parentBoxHelper) {
    setParentHelperVisible(parentGroup, false);
  }
  
  // Move object to the parent group's parent (preserving local transform)
  const grandParent = parentGroup.parent || scene;
  const wasInParentGroup = grandParent && grandParent !== scene && grandParent.userData?.isEditorGroup;
  
  if (grandParent === scene) {
    canvasRoot.attach(obj);
  } else {
    grandParent.attach(obj);
  }
  
  createBoxHelperFor(obj);
  setHelperVisible(obj, false);
  
  // Restore original sidebar representation and label
  if (obj.userData?.originalName) obj.name = obj.userData.originalName;
  const listType = obj.userData?.originalListType || obj.userData?.listType || (obj instanceof THREE.Group ? "group" : "model");
  
  // Sidebar will be rebuilt below if we're in a parent group
  // Otherwise add to root of sidebar
  if (!wasInParentGroup) {
    if (listType === "group") addGroupToList(obj, obj.name || "Attached");
    else addModelToList(obj, obj.name || "Model");
  }
  
  delete obj.userData?.originalListType;
  delete obj.userData?.originalName;
  
  // Update visuals without clamping to preserve local positions during detaching
  updateModelProperties(obj);
  updatePropertiesPanel(obj);
  updateBoxHelper(obj);
  
  // If this is a group, also update child bounding boxes
  if (obj.userData?.isEditorGroup) {
    updateChildBoundingBoxes(obj);
  }
  
  // Rebuild the parent group's sidebar
  rebuildGroupSidebar(parentGroup);
  
  // If we're in a nested group, rebuild that too
  if (wasInParentGroup) {
    rebuildGroupSidebar(grandParent);
  }
  
  // Update parent group's bounding boxes
  updateParentGroupBounds(parentGroup);
  
  // Keep the object selected after detaching (unless we're batch detaching)
  if (!skipSelection) {
    selectObject(obj);
    saveState();
    updateJSONEditorFromScene();
  }
  
  return true;
}

function detachSelectedFromGroup(){
  if (selectedObjects.length === 0) return;
  
  // Detach all selected objects that are children in groups
  const objectsToDetach = selectedObjects.filter(obj => {
    if (!isChildObjectInGroup(obj)) return false;
    const parentGroup = obj.parent;
    // Only allow if parent group has at least 3 children (parent + 2 non-parent children)
    return parentGroup.children.length >= 3;
  });
  
  if (objectsToDetach.length === 0) return;
  
  // Clear current selection and hide all bounding boxes first
  selectedObjects.forEach(obj => {
    obj.userData.listItem?.classList.remove("selected");
    setHelperVisible(obj, false);
    if (obj.userData.dimGroup) scene.remove(obj.userData.dimGroup);
    // Also hide parent box helpers
    if (isChildObjectInGroup(obj) && obj.parent) {
      setParentHelperVisible(obj.parent, false);
    }
  });
  selectedObjects = [];
  selectedObject = null;
  transform.detach();
  
  // Detach all objects without selecting them individually
  const detachedObjects = [];
  objectsToDetach.forEach(obj => {
    const success = detachFromGroup(obj, true); // skipSelection = true
    if (success) {
      detachedObjects.push(obj);
    }
  });
  
  // Now select all successfully detached objects at once
  if (detachedObjects.length > 0) {
    selectedObjects = [...detachedObjects];
    selectedObject = detachedObjects[detachedObjects.length - 1];
    
    // Show selection for all detached objects
    detachedObjects.forEach(obj => {
      obj.userData.listItem?.classList.add("selected");
      setHelperVisible(obj, true);
      updateBoxHelper(obj, BOX_COLORS.selected);
      addBoundingBoxDimensions(obj);
    });
    
    updateModelProperties(selectedObject);
    updatePropertiesPanel(selectedObject);
    updateTransformButtonStates();
    saveState();
    updateJSONEditorFromScene();
  }
}

// ===== Helper function to check if group should be removed =====
function shouldRemoveEmptyGroup(group) {
  if (!group || !group.userData?.isEditorGroup) return false;

  // If group has only 1 child (the parent object), it should be removed
  // If group has 0 children, it should definitely be removed
  return group.children.length <= 1;
}

function cleanupEmptyParentGroups(parentGroup) {
  if (!parentGroup || !parentGroup.userData?.isEditorGroup) return;

  if (shouldRemoveEmptyGroup(parentGroup)) {
    const grandParent = parentGroup.parent;

    // If there's still one child (the parent object), restore it to the scene
    if (parentGroup.children.length === 1) {
      const parentObject = parentGroup.children[0];

      // Restore the parent object's transform and add it back to scene
      scene.attach(parentObject);

      // Restore original sidebar representation
      // For the parent object (first child), it might not have originalName/originalListType
      // so we use the group's name and determine type based on object type
      if (parentObject.userData?.originalName) {
        parentObject.name = parentObject.userData.originalName;
      } else {
        // Use the group's name as fallback since the parent object was the basis for the group
        parentObject.name = parentGroup.name || parentObject.name || "Model";
      }

      const listType = parentObject.userData?.originalListType ||
                      (parentObject instanceof THREE.Group && parentObject.userData?.isEditorGroup ? "group" : "model");

      if (listType === "group") {
        addGroupToList(parentObject, parentObject.name || "Attached");
      } else {
        addModelToList(parentObject, parentObject.name || "Model");
      }

      // Clean up the metadata
      delete parentObject.userData?.originalListType;
      delete parentObject.userData?.originalName;

      // Create box helper for the restored object
      createBoxHelperFor(parentObject);
      updateAllVisuals(parentObject);
    }

    // Clean up and remove the empty group
    cleanupObject(parentGroup);
    if (parentGroup.parent) {
      parentGroup.parent.remove(parentGroup);
    } else {
      scene.remove(parentGroup);
    }

    // Recursively check if the grandparent group should also be removed
    if (grandParent && grandParent !== scene) {
      cleanupEmptyParentGroups(grandParent);
    }
  }
}

// ===== Drag and Drop Attaching =====
function handleDragStart(e) {
  const li = e.target.closest('li');
  if (!li) return;

  const objectId = li.getAttribute('data-object-id');
  draggedObject = scene.getObjectByProperty('uuid', objectId);
  draggedItem = li;

  // Check if the dragged object is part of the current selection
  if (selectedObjects.includes(draggedObject)) {
    // Drag all selected objects
    draggedObjects = [...selectedObjects];
    // Add visual feedback to all selected items
    selectedObjects.forEach(obj => {
      if (obj.userData.listItem) {
        obj.userData.listItem.classList.add('dragging');
        if (selectedObjects.length > 1) {
          obj.userData.listItem.classList.add('multi-select');
        }
      }
    });
  } else {
    // Drag only the single object
    draggedObjects = [draggedObject];
    li.classList.add('dragging');
  }

  // Set drag effect
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', objectId);
}

function handleDragEnd(e) {
  // Clean up drag state and visual feedback for all dragged objects
  draggedObjects.forEach(obj => {
    if (obj.userData.listItem) {
      obj.userData.listItem.classList.remove('dragging');
      obj.userData.listItem.classList.remove('multi-select');
    }
  });

  // Remove drag-over class from all items
  document.querySelectorAll('#modelList li.drag-over').forEach(item => {
    item.classList.remove('drag-over');
  });

  // Reset drag state
  draggedObject = null;
  draggedObjects = [];
  draggedItem = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function handleDragEnter(e) {
  e.preventDefault();
  const li = e.target.closest('li');
  if (!li || li === draggedItem) return;

  const targetObjectId = li.getAttribute('data-object-id');
  const targetObject = scene.getObjectByProperty('uuid', targetObjectId);

  // Check if this is a valid drop target for all dragged objects
  const allValid = draggedObjects.every(draggedObj =>
    isValidDropTarget(draggedObj, targetObject)
  );

  if (allValid) {
    li.classList.add('drag-over');
  }
}

function handleDragLeave(e) {
  const li = e.target.closest('li');
  if (!li) return;

  // Only remove drag-over if we're actually leaving the element
  const rect = li.getBoundingClientRect();
  const x = e.clientX;
  const y = e.clientY;

  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    li.classList.remove('drag-over');
  }
}

function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();

  const li = e.target.closest('li');
  if (!li || li === draggedItem) return;

  const targetObjectId = li.getAttribute('data-object-id');
  const targetObject = scene.getObjectByProperty('uuid', targetObjectId);

  // Clean up visual feedback
  li.classList.remove('drag-over');
  draggedObjects.forEach(obj => {
    if (obj.userData.listItem) {
      obj.userData.listItem.classList.remove('dragging');
      obj.userData.listItem.classList.remove('multi-select');
    }
  });

  // Perform the grouping operation for multiple objects
  if (draggedObjects.length > 0 && targetObject) {
    // Validate all objects can be dropped
    const allValid = draggedObjects.every(draggedObj =>
      isValidDropTarget(draggedObj, targetObject)
    );

    if (allValid) {
      createGroupFromMultipleDragDrop(draggedObjects, targetObject);
    }
  }

  // Reset drag state
  draggedObject = null;
  draggedObjects = [];
  draggedItem = null;
}

function isValidDropTarget(draggedObj, targetObj) {
  if (!draggedObj || !targetObj) return false;
  if (draggedObj === targetObj) return false;

  // Prevent dropping a parent group onto its own child
  if (isDescendantOf(targetObj, draggedObj)) return false;

  // Prevent dropping a child object onto its parent group
  if (draggedObj.parent && draggedObj.parent.userData?.isEditorGroup && targetObj === draggedObj.parent) {
    return false;
  }

  // Prevent dropping Object Root children onto Object Root itself
  if (draggedObj.parent && draggedObj.parent.userData?.isCanvasRoot && targetObj.userData?.isCanvasRoot) {
    return false;
  }

  // Restrict: If dragged object is a child in a group, only allow dropping within its own parent group
  // This allows nesting child elements within the same group
  if (draggedObj.parent && draggedObj.parent.userData?.isEditorGroup) {
    const draggedParent = draggedObj.parent;
    // Allow dropping onto:
    // 1. Siblings within the same parent group (for nesting)
    // Note: Dropping onto the parent group itself is now prevented above
    if (targetObj.parent !== draggedParent) {
      return false;
    }
  }

  // Groups can be dropped onto other groups (to add as children)
  // or onto regular objects (to create nested groups)
  // Child elements can be nested into other children within the same parent group

  return true;
}

function isDescendantOf(obj, ancestor) {
  let current = obj.parent;
  while (current && current !== scene) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function createGroupFromDragDrop(draggedObj, targetObj) {
  // If target is already a group, just add the dragged object to it
  if (targetObj instanceof THREE.Group && targetObj.userData?.isEditorGroup) {
    addObjectToExistingGroup(draggedObj, targetObj);
    return;
  }

  // Create a new group with target as parent
  const group = new THREE.Group();
  group.userData.isSelectable = true;
  group.userData.isEditorGroup = true;
  group.name = targetObj.name || "Attached " + Date.now();

  // Store target object's world transform to preserve visual position
  const targetWorldPosition = new THREE.Vector3();
  const targetWorldQuaternion = new THREE.Quaternion();
  const targetWorldScale = new THREE.Vector3();
  targetObj.getWorldPosition(targetWorldPosition);
  targetObj.getWorldQuaternion(targetWorldQuaternion);
  targetObj.getWorldScale(targetWorldScale);

  // Copy target object's transform to the group
  group.position.copy(targetObj.position);
  group.quaternion.copy(targetObj.quaternion);
  group.scale.copy(targetObj.scale);

  // Remember if target was in a parent group
  const targetParent = targetObj.parent;
  const wasInGroup = targetParent && targetParent.userData?.isEditorGroup;

  // Remove target object from its current parent and add it as first child of group
  if (targetParent) {
    targetParent.remove(targetObj);
  } else {
    scene.remove(targetObj);
  }
  group.add(targetObj);

  // Add group to canvas root or parent FIRST (before matrix calculations)
  // This ensures the group has a valid transform for local calculations
  if (wasInGroup) {
    targetParent.add(group);
  } else {
    canvasRoot.add(group);
  }

  // Calculate local transform to preserve target object's world position
  scene.updateMatrixWorld(true);
  const groupWorldMatrix = new THREE.Matrix4();
  group.updateMatrixWorld(true);
  groupWorldMatrix.copy(group.matrixWorld);

  const targetWorldMatrix = new THREE.Matrix4();
  targetWorldMatrix.compose(targetWorldPosition, targetWorldQuaternion, targetWorldScale);

  const localMatrix = new THREE.Matrix4();
  localMatrix.copy(groupWorldMatrix).invert().multiply(targetWorldMatrix);

  const localPosition = new THREE.Vector3();
  const localQuaternion = new THREE.Quaternion();
  const localScale = new THREE.Vector3();
  localMatrix.decompose(localPosition, localQuaternion, localScale);

  // Apply calculated local transform to preserve visual position
  targetObj.position.copy(localPosition);
  targetObj.quaternion.copy(localQuaternion);
  targetObj.scale.copy(localScale);

  // Clean up target object's sidebar representation
  if (targetObj.userData.listItem) {
    const li = targetObj.userData.listItem;
    const next = li.nextSibling;
    li.remove();
    if(next && next.tagName==="UL") next.remove();
    delete targetObj.userData.listItem;
  }

  // Now add dragged object to the group (local transform will be preserved correctly)
  addObjectToGroup(draggedObj, group);

  // Update visuals and sidebar
  if (wasInGroup) {
    rebuildGroupSidebar(targetParent);

    // For nested groups, only update visuals (no clamping)
    updateModelProperties(group);
    updatePropertiesPanel(group);
    updateBoxHelper(group);
    updateChildBoundingBoxes(group);
    updateParentGroupBounds(targetParent);
  } else {
    createBoxHelperFor(group);
    createParentBoxHelperFor(group);
    addGroupToList(group, group.name);

    // For top-level groups, apply clamping
    updateAllVisuals(group);
  }

  storeInitialTransform(group);
  selectObject(group);
  saveState();
  updateJSONEditorFromScene();
}

function addObjectToExistingGroup(obj, group) {
  // If the object is already a direct child of the target group, do nothing
  if (obj.parent === group) {
    return;
  }

  // Store reference to original parent for cleanup
  const objParent = obj.parent;
  
  // Add to the target group (this will handle parent removal, sidebar cleanup and local transform preservation)
  addObjectToGroup(obj, group);
  
  // Handle cleanup of original parent if it was a group
  if (objParent && objParent.userData?.isEditorGroup) {
    rebuildGroupSidebar(objParent);
    // Check if parent group should be cleaned up after removing the object
    cleanupEmptyParentGroups(objParent);
  }

  // Rebuild the group's sidebar
  rebuildGroupSidebar(group);

  // Update visuals without clamping to preserve local positions
  updateModelProperties(group);
  updatePropertiesPanel(group);
  updateBoxHelper(group);

  // If this is a group, also update child bounding boxes
  if (group.userData?.isEditorGroup) {
    updateChildBoundingBoxes(group);
  }

  // If this object is a child in a group, update the parent group's bounding box
  if (isChildObjectInGroup(group) && group.parent) {
    updateParentGroupBounds(group.parent);
  }

  saveState();
  updateJSONEditorFromScene();
}

function addObjectToGroup(obj, group) {
  // Store original metadata
  if (!obj.userData) obj.userData = {};
  obj.userData.originalListType = obj.userData.listType || (obj instanceof THREE.Group ? "group" : "model");
  obj.userData.originalName = obj.name;

  // Clean up existing helpers
  if(obj.userData.boxHelper){ scene.remove(obj.userData.boxHelper); delete obj.userData.boxHelper; }
  if(obj.userData.dimGroup){ scene.remove(obj.userData.dimGroup); delete obj.userData.dimGroup; }

  // Remove from current sidebar listing
  if (obj.userData.listItem) {
    const li = obj.userData.listItem;
    const next = li.nextSibling;
    li.remove();
    if(next && next.tagName==="UL") next.remove();
    delete obj.userData.listItem;
  }

  // --- World position preservation logic ---
  // Store the object's world transform before grouping to preserve visual position
  const worldPosition = new THREE.Vector3();
  const worldQuaternion = new THREE.Quaternion();
  const worldScale = new THREE.Vector3();
  obj.getWorldPosition(worldPosition);
  obj.getWorldQuaternion(worldQuaternion);
  obj.getWorldScale(worldScale);

  // Remove object from its current parent first
  const objParent = obj.parent;
  if (objParent) {
    objParent.remove(obj);
  }

  // Add object to group to establish proper parent-child relationship
  group.add(obj);

  // Ensure the group and all ancestors are in the scene and matrices are up-to-date
  scene.updateMatrixWorld(true);

  // Calculate the correct local transform to preserve world position
  const groupWorldMatrix = new THREE.Matrix4();
  group.updateMatrixWorld(true);
  groupWorldMatrix.copy(group.matrixWorld);

  const targetWorldMatrix = new THREE.Matrix4();
  targetWorldMatrix.compose(worldPosition, worldQuaternion, worldScale);

  const localMatrix = new THREE.Matrix4();
  localMatrix.copy(groupWorldMatrix).invert().multiply(targetWorldMatrix);

  // Decompose and set the local transform
  const localPosition = new THREE.Vector3();
  const localQuaternion = new THREE.Quaternion();
  const localScale = new THREE.Vector3();
  localMatrix.decompose(localPosition, localQuaternion, localScale);

  // Apply the calculated local transform
  obj.position.copy(localPosition);
  obj.quaternion.copy(localQuaternion);
  obj.scale.copy(localScale);
}

function createGroupFromMultipleDragDrop(draggedObjects, targetObj) {
  if (draggedObjects.length === 0) return;

  // If target is already a group, add all objects to it
  if (targetObj instanceof THREE.Group && targetObj.userData?.isEditorGroup) {
    draggedObjects.forEach(draggedObj => {
      addObjectToExistingGroup(draggedObj, targetObj);
    });
    return;
  }

  // Create a new group with target as parent
  const group = new THREE.Group();
  group.userData.isSelectable = true;
  group.userData.isEditorGroup = true;
  group.name = targetObj.name || "Attached " + Date.now();

  // Store target object's world transform to preserve visual position
  const targetWorldPosition = new THREE.Vector3();
  const targetWorldQuaternion = new THREE.Quaternion();
  const targetWorldScale = new THREE.Vector3();
  targetObj.getWorldPosition(targetWorldPosition);
  targetObj.getWorldQuaternion(targetWorldQuaternion);
  targetObj.getWorldScale(targetWorldScale);

  // Copy target object's transform to the group
  group.position.copy(targetObj.position);
  group.quaternion.copy(targetObj.quaternion);
  group.scale.copy(targetObj.scale);

  // Remember if target was in a parent group
  const targetParent = targetObj.parent;
  const wasInGroup = targetParent && targetParent.userData?.isEditorGroup;

  // Remove target object from its current parent and add it as first child of group
  if (targetParent) {
    targetParent.remove(targetObj);
  } else {
    scene.remove(targetObj);
  }
  group.add(targetObj);

  // Add group to canvas root or parent FIRST (before matrix calculations)
  // This ensures the group has a valid transform for local calculations
  if (wasInGroup) {
    targetParent.add(group);
  } else {
    canvasRoot.add(group);
  }

  // Calculate local transform to preserve target object's world position
  scene.updateMatrixWorld(true);
  const groupWorldMatrix = new THREE.Matrix4();
  group.updateMatrixWorld(true);
  groupWorldMatrix.copy(group.matrixWorld);

  const targetWorldMatrix = new THREE.Matrix4();
  targetWorldMatrix.compose(targetWorldPosition, targetWorldQuaternion, targetWorldScale);

  const localMatrix = new THREE.Matrix4();
  localMatrix.copy(groupWorldMatrix).invert().multiply(targetWorldMatrix);

  const localPosition = new THREE.Vector3();
  const localQuaternion = new THREE.Quaternion();
  const localScale = new THREE.Vector3();
  localMatrix.decompose(localPosition, localQuaternion, localScale);

  // Apply calculated local transform to preserve visual position
  targetObj.position.copy(localPosition);
  targetObj.quaternion.copy(localQuaternion);
  targetObj.scale.copy(localScale);

  // Clean up target object's sidebar representation
  if (targetObj.userData.listItem) {
    const li = targetObj.userData.listItem;
    const next = li.nextSibling;
    li.remove();
    if(next && next.tagName==="UL") next.remove();
    delete targetObj.userData.listItem;
  }

  // Now add all dragged objects to the group (local transforms will be preserved correctly)
  draggedObjects.forEach(draggedObj => {
    addObjectToGroup(draggedObj, group);
  });

  // Update visuals and sidebar
  if (wasInGroup) {
    rebuildGroupSidebar(targetParent);

    // For nested groups, only update visuals (no clamping)
    updateModelProperties(group);
    updatePropertiesPanel(group);
    updateBoxHelper(group);
    updateChildBoundingBoxes(group);
    updateParentGroupBounds(targetParent);
  } else {
    createBoxHelperFor(group);
    createParentBoxHelperFor(group);
    addGroupToList(group, group.name);

    // For top-level groups, apply clamping
    updateAllVisuals(group);
  }

  storeInitialTransform(group);
  selectObject(group);
  saveState();
  updateJSONEditorFromScene();
}

// ===== Duplication =====
function duplicateObject(obj, offset = new THREE.Vector3(1, 0, 1)) {
  if (!obj || !obj.userData?.isSelectable || obj.userData?.isCanvasRoot) return null;

  let duplicate;

  if (obj instanceof THREE.Group && obj.userData?.isEditorGroup) {
    // Handle editor groups
    duplicate = new THREE.Group();
    duplicate.userData.isSelectable = true;
    duplicate.userData.isEditorGroup = true;

    // Copy transform
    duplicate.position.copy(obj.position).add(offset);
    duplicate.quaternion.copy(obj.quaternion);
    duplicate.scale.copy(obj.scale);

    // Generate unique name
    duplicate.name = generateUniqueName(obj.name || "Attached");

    // Copy source reference from the first child (parent object)
    if (obj.children[0]?.userData?.sourceRef) {
      duplicate.userData.sourceRef = { ...obj.children[0].userData.sourceRef };
    }

    // Duplicate all children
    obj.children.forEach(child => {
      const childDuplicate = duplicateObject(child, new THREE.Vector3(0, 0, 0)); // No offset for children
      if (childDuplicate) {
        duplicate.add(childDuplicate);
      }
    });
  } else {
    // Handle regular models
    duplicate = obj.clone(true); // Deep clone with children

    // Deep clone materials and geometries to avoid sharing
    duplicate.traverse(node => {
      if (node.isMesh) {
        if (node.material) {
          if (Array.isArray(node.material)) {
            node.material = node.material.map(mat => mat.clone());
          } else {
            node.material = node.material.clone();
          }
        }
        if (node.geometry) {
          node.geometry = node.geometry.clone();
        }
      }
    });

    // Copy and update userData
    duplicate.userData = { ...obj.userData };
    duplicate.userData.isSelectable = true;

    // Copy source reference
    if (obj.userData?.sourceRef) {
      duplicate.userData.sourceRef = { ...obj.userData.sourceRef };
    }

    // Generate unique name
    duplicate.name = generateUniqueName(obj.name || "Model");

    // Apply position offset
    duplicate.position.copy(obj.position).add(offset);
  }

  // Clear any existing helpers and list items
  delete duplicate.userData.boxHelper;
  delete duplicate.userData.parentBoxHelper;
  delete duplicate.userData.dimGroup;
  delete duplicate.userData.listItem;

  return duplicate;
}

function generateUniqueName(baseName) {
  const existingNames = new Set();
  scene.traverse(obj => {
    if (obj.name) existingNames.add(obj.name);
  });

  let counter = 1;
  let newName = `${baseName} Copy`;

  while (existingNames.has(newName)) {
    counter++;
    newName = `${baseName} Copy ${counter}`;
  }

  return newName;
}

function duplicateSelectedObjects() {
  if (selectedObjects.length === 0) return;

  const duplicates = [];
  const offset = new THREE.Vector3(1, 0, 1); // Default offset for non-gizmo duplication

  // Filter out canvas root from duplication
  const objectsToDuplicate = selectedObjects.filter(obj => !obj.userData?.isCanvasRoot);
  if (objectsToDuplicate.length === 0) return;

  objectsToDuplicate.forEach(obj => {
    const duplicate = duplicateObject(obj, offset);
    if (duplicate) {
      // Add to scene (or parent group if original was in a group)
      const originalParent = obj.parent;
      if (originalParent && originalParent.userData?.isEditorGroup && originalParent !== scene) {
        // If original was in a group, add duplicate to the same group
        originalParent.add(duplicate);
        // Update the parent group's sidebar
        rebuildGroupSidebar(originalParent);
      } else {
        // Add to canvas root
        canvasRoot.add(duplicate);
        // Add to sidebar
        if (duplicate.userData?.isEditorGroup) {
          addGroupToList(duplicate, duplicate.name);
        } else {
          addModelToList(duplicate, duplicate.name);
        }
      }

      createBoxHelperFor(duplicate);

      // Store initial transform and apply canvas constraints
      storeInitialTransform(duplicate);
      clampToCanvasRecursive(duplicate);
      updateAllVisuals(duplicate);

      duplicates.push(duplicate);
    }
  });

  // Select the duplicated objects
  if (duplicates.length > 0) {
    selectedObjects.forEach(obj => {
      obj.userData.listItem?.classList.remove("selected");
      setHelperVisible(obj, false);
      if (obj.userData.dimGroup) scene.remove(obj.userData.dimGroup);
    });

    selectedObjects = [...duplicates];
    selectedObject = duplicates[duplicates.length - 1];

    duplicates.forEach(obj => {
      obj.userData.listItem?.classList.add("selected");
      setHelperVisible(obj, true);
      updateBoxHelper(obj, BOX_COLORS.selected);
      addBoundingBoxDimensions(obj);
    });

    updateModelProperties(selectedObject);
    updatePropertiesPanel(selectedObject);
    updateTransformButtonStates();

    // Attach transform to the last selected duplicate
    if (selectedObject && isEditingAllowed()) {
      transform.attach(selectedObject);
    }

    saveState();
  }
}

// ===== Delete =====
function deleteObject(obj){
  if(!obj || obj.userData?.isCanvasRoot) return;
  if(transform.object===obj) transform.detach();

  // Remember the parent group before deletion
  const parentGroup = obj.parent && obj.parent.userData?.isEditorGroup ? obj.parent : null;

  if (obj instanceof THREE.Group) {
    const children = [...obj.children];
    children.forEach(child=>{
      cleanupObject(child);
      obj.remove(child);
    });
  }
  cleanupObject(obj);
  if(obj.parent) obj.parent.remove(obj);
  selectedObjects = selectedObjects.filter(o=>o!==obj);
  if(selectedObject===obj) selectedObject=null;
  updatePropertiesPanel(selectedObject||null);

  // After deletion, check if parent group should be removed
  if (parentGroup) {
    cleanupEmptyParentGroups(parentGroup);
  }

  // Update JSON editor
  updateJSONEditorFromScene();
}

// ===== Camera helpers =====
function animateCamera(toPos, toTarget, duration=800){
  const fromPos = camera.position.clone();
  const fromTarget = orbit.target.clone();
  const start = performance.now();
  const ease = t => (t<0.5?2*t*t:-1+(4-2*t)*t);
  function step(now){
    const t = Math.min(1, (now-start)/duration);
    const k = ease(t);
    camera.position.lerpVectors(fromPos, toPos, k);
    orbit.target.lerpVectors(fromTarget, toTarget, k);
    camera.lookAt(orbit.target);
    if (t<1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function frameCameraOn(obj){
  const box = getBox(obj);
  const sizeLen = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  const newPos = center.clone().add(new THREE.Vector3(sizeLen,sizeLen,sizeLen));
  animateCamera(newPos, center);
}

function resetCamera(){
  if(selectedObject) frameCameraOn(selectedObject);
  else animateCamera(new THREE.Vector3(groundSize,groundSize,groundSize), new THREE.Vector3(0,0,0));
}

// ===== Canvas size & snap =====
canvasSizeInput.addEventListener("change", e=>{
  groundSize = parseFloat(e.target.value) || 20;
  scene.remove(grid);
  grid = new THREE.GridHelper(groundSize, groundSize, 0x888888, 0x444444);
  grid.userData.isSelectable = false;
  scene.add(grid);
  if (ruler) scene.remove(ruler);
  if (loadedFont) {
    ruler = createRuler(groundSize,1);
    addRulerLabels(ruler,groundSize,1,loadedFont);
    ruler.userData.isSelectable = false;
    scene.add(ruler);
  }
  orbit.maxDistance = groundSize * 1.5;
  selectedObjects.forEach(o=>updateAllVisuals(o));
  
  // Update canvas root box helper if it exists
  if (canvasRoot.userData.boxHelper) {
    updateCanvasBoxHelper(canvasRoot);
  }
  
  // Update Object Root aBound and properties to reflect new canvas size
  canvasRoot.userData.aBound = [groundSize, groundSize, groundSize];
  updateModelProperties(canvasRoot);
  if (selectedObjects.includes(canvasRoot)) {
    updatePropertiesPanel(canvasRoot);
  }

  // Update JSON editor
  updateJSONEditor();
});

snapCheckbox.addEventListener("change", e=>{
  const enabled = e.target.checked;
  transform.setTranslationSnap(enabled?1:null);
  transform.setRotationSnap(enabled?THREE.MathUtils.degToRad(15):null);
});

// ===== Hover & selection (canvas) =====
renderer.domElement.addEventListener("mousemove", e=>{
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX-rect.left)/rect.width)*2-1,
    -((e.clientY-rect.top)/rect.height)*2+1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects([canvasRoot], true);
  let obj = null;
  if (hits.length>0){
    obj = hits[0].object;
    // Walk up the hierarchy to find the topmost selectable object
    while (obj.parent && !obj.userData.isSelectable) obj = obj.parent;
    
    // If we found a selectable object, check if it's a child in a deeply nested group
    if (obj.userData.isSelectable) {
      // For deeply nested groups, we want to hover the topmost group that contains this object
      let topmostSelectable = obj;
      let current = obj;
      while (current.parent && current.parent !== canvasRoot) {
        if (current.parent.userData.isSelectable) {
          topmostSelectable = current.parent;
        }
        current = current.parent;
      }
      obj = topmostSelectable;
    } else {
      obj = null;
    }
  }
  if (hoveredObject && !selectedObjects.includes(hoveredObject)) setHelperVisible(hoveredObject,false);
  hoveredObject = obj;
  if (hoveredObject && !selectedObjects.includes(hoveredObject)){
    updateBoxHelper(hoveredObject, BOX_COLORS.hover);
    setHelperVisible(hoveredObject,true);
  }
});

renderer.domElement.addEventListener("click", e=>{
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX-rect.left)/rect.width)*2-1,
    -((e.clientY-rect.top)/rect.height)*2+1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects([canvasRoot], true);
  if (hits.length>0){
    let obj = hits[0].object;
    // Walk up the hierarchy to find the topmost selectable object
    while (obj.parent && !obj.userData.isSelectable) obj = obj.parent;
    
    // If we found a selectable object, check if it's a child in a deeply nested group
    if (obj.userData.isSelectable) {
      // For deeply nested groups, we want to select the topmost group that contains this object
      // Walk up to find the topmost selectable parent that's not the canvas root
      let topmostSelectable = obj;
      let current = obj;
      while (current.parent && current.parent !== canvasRoot) {
        if (current.parent.userData.isSelectable) {
          topmostSelectable = current.parent;
        }
        current = current.parent;
      }
      
      selectFromCanvas(topmostSelectable, e.shiftKey);
      frameCameraOn(topmostSelectable);
    }
  }
});

// ===== Double-click focus =====
renderer.domElement.addEventListener("dblclick", e=>{
  if (transform.dragging) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX-rect.left)/rect.width)*2-1,
    -((e.clientY-rect.top)/rect.height)*2+1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects([canvasRoot], true);
  let target = null;
  if (hits.length>0){
    let obj = hits[0].object;
    // Walk up the hierarchy to find the topmost selectable object
    while (obj.parent && !obj.userData.isSelectable) obj = obj.parent;
    
    // If we found a selectable object, check if it's a child in a deeply nested group
    if (obj.userData.isSelectable) {
      // For deeply nested groups, we want to focus on the topmost group that contains this object
      let topmostSelectable = obj;
      let current = obj;
      while (current.parent && current.parent !== canvasRoot) {
        if (current.parent.userData.isSelectable) {
          topmostSelectable = current.parent;
        }
        current = current.parent;
      }
      target = topmostSelectable;
    }
  }
  if (target) { selectFromCanvas(target, false); frameCameraOn(target); }
  else resetCamera();
});

// ===== Keyboard shortcuts =====
window.addEventListener("keydown", e=>{
  const key = e.key.toLowerCase();
  const inForm = (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
  const isJSONEditor = e.target === jsonEditor;
  const isHotkey = ["w","e","r","q","f","h","z","delete","d","alt"].includes(key);
  
  // Block all hotkeys when JSON editor is focused
  if (isJSONEditor) return;
  
  if (inForm && !isHotkey) return;

  // Track Alt key for duplication
  if (key === "alt") {
    isAltPressed = true;
  }

  switch(key){
    case "w":
      if (isEditingAllowed()) transform.setMode("translate");
      break;
    case "e":
      if (isEditingAllowed()) transform.setMode("rotate");
      break;
    case "r":
      if (isEditingAllowed()) transform.setMode("scale");
      break;
    case "q":
      if(e.shiftKey){ if(selectedObject) transform.attach(selectedObject); }
      else transform.detach();
      break;
    case "f": if(selectedObject) frameCameraOn(selectedObject); break;
    case "h": {
      const helpOverlay = document.getElementById("helpOverlay");
      if(helpOverlay) helpOverlay.style.display = (helpOverlay.style.display==="none"||helpOverlay.style.display==="")?"block":"none";
      break;
    }
    case "delete":
      // Filter out canvas root from deletion
      const objectsToDelete = selectedObjects.filter(obj => !obj.userData?.isCanvasRoot);
      if(objectsToDelete.length) [...objectsToDelete].forEach(deleteObject);
      else if (selectedObject && !selectedObject.userData?.isCanvasRoot) deleteObject(selectedObject);
      
      // If only Object Root is selected, do nothing
      if (selectedObjects.length === 1 && selectedObjects[0].userData?.isCanvasRoot) {
        return;
      }
      break;
    case "d":
      if ((e.ctrlKey || e.metaKey) && !inForm) {
        e.preventDefault();
        duplicateSelectedObjects();
      }
      break;
    default:
      if ((e.ctrlKey||e.metaKey) && key==="z"){ e.preventDefault(); undo(); }
      break;
  }
});

window.addEventListener("keyup", e=>{
  const key = e.key.toLowerCase();

  // Track Alt key release
  if (key === "alt") {
    isAltPressed = false;
  }
});

// ===== Fix #ui buttons =====
btnTranslate.onclick = () => {
  if (isEditingAllowed()) transform.setMode("translate");
};
btnRotate.onclick = () => {
  if (isEditingAllowed()) transform.setMode("rotate");
};
btnScale.onclick = () => {
  if (isEditingAllowed()) transform.setMode("scale");
};
btnDelete.onclick = () => {
  // Filter out canvas root from deletion
  const objectsToDelete = selectedObjects.filter(obj => !obj.userData?.isCanvasRoot);
  if(objectsToDelete.length) [...objectsToDelete].forEach(deleteObject);
  else if (selectedObject && !selectedObject.userData?.isCanvasRoot) deleteObject(selectedObject);
  
  // If only Object Root is selected, do nothing
  if (selectedObjects.length === 1 && selectedObjects[0].userData?.isCanvasRoot) {
    return;
  }
};
btnUndo.onclick = () => undo();
btnResetCamera.onclick = () => resetCamera();

// ===== Resize =====
window.addEventListener("resize", ()=>{
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  selectedObjects.forEach(o=>updateBoxHelper(o));
  if (hoveredObject) updateBoxHelper(hoveredObject);
});

// ===== Transform events =====
transform.addEventListener("dragging-changed", e=>{
  orbit.enabled = !e.value;

  if (e.value) {
    // Starting to drag - store the last valid position
    if (selectedObject && !selectedObject.userData?.isCanvasRoot) {
      lastValidPosition = selectedObject.position.clone();
      lastValidQuaternion = selectedObject.quaternion.clone();
      lastValidScale = selectedObject.scale.clone();
    }
    
    if (isAltPressed && selectedObject && !isDuplicating && !selectedObject.userData?.isCanvasRoot) {
      // Create duplicate and switch to it
      isDuplicating = true;
      originalObject = selectedObject;

      const duplicate = duplicateObject(selectedObject, new THREE.Vector3(0, 0, 0)); // No initial offset for gizmo duplication
      if (duplicate) {
        // Add to scene (or parent group if original was in a group)
        const originalParent = selectedObject.parent;
        if (originalParent && originalParent.userData?.isEditorGroup && originalParent !== scene) {
          // If original was in a group, add duplicate to the same group
          originalParent.add(duplicate);
          // Update the parent group's sidebar
          rebuildGroupSidebar(originalParent);
        } else {
          // Add to canvas root
          canvasRoot.add(duplicate);
          // Add to sidebar
          if (duplicate.userData?.isEditorGroup) {
            addGroupToList(duplicate, duplicate.name);
          } else {
            addModelToList(duplicate, duplicate.name);
          }
        }

        createBoxHelperFor(duplicate);

        // Store initial transform and apply canvas constraints
        storeInitialTransform(duplicate);

        // Switch selection to duplicate
        selectedObjects.forEach(obj => {
          obj.userData.listItem?.classList.remove("selected");
          setHelperVisible(obj, false);
          if (obj.userData.dimGroup) scene.remove(obj.userData.dimGroup);
        });

        selectedObjects = [duplicate];
        selectedObject = duplicate;

        duplicate.userData.listItem?.classList.add("selected");
        setHelperVisible(duplicate, true);
        updateBoxHelper(duplicate, BOX_COLORS.editing);

        // Attach transform to duplicate
        transform.attach(duplicate);

        updateModelProperties(duplicate);
        updatePropertiesPanel(duplicate);
      }
    }
  } else {
    // Finished dragging - clean up stored positions
    lastValidPosition = null;
    lastValidQuaternion = null;
    lastValidScale = null;
    
    if (isDuplicating) {
      isDuplicating = false;
      originalObject = null;

      // Apply canvas constraints to the duplicate
      if (selectedObject) {
        clampToCanvasRecursive(selectedObject);
        updateAllVisuals(selectedObject);
        addBoundingBoxDimensions(selectedObject);
      }
    } else {
      // Apply clamping after any transform operation is completed
      if (selectedObject) {
        clampToCanvasRecursive(selectedObject);
        updateAllVisuals(selectedObject);
      }
    }

    selectedObjects.forEach(o=>{
      updateBoxHelper(o, BOX_COLORS.selected);
      setHelperVisible(o,true);
    });

    if (!isDuplicating) saveState();
  }
});

transform.addEventListener("objectChange", ()=>{
  if(!selectedObject) return;

  const mode = transform.getMode();

  // Check if the object would exceed bounds during dragging
  if (transform.dragging && wouldExceedBounds(selectedObject)) {
    // Restore the last valid position to prevent movement beyond bounds
    if (lastValidPosition && lastValidQuaternion && lastValidScale) {
      selectedObject.position.copy(lastValidPosition);
      selectedObject.quaternion.copy(lastValidQuaternion);
      selectedObject.scale.copy(lastValidScale);
      return; // Skip the rest of the function since we've restored the position
    }
  } else if (transform.dragging) {
    // Update the last valid position if we're still within bounds
    lastValidPosition = selectedObject.position.clone();
    lastValidQuaternion = selectedObject.quaternion.clone();
    lastValidScale = selectedObject.scale.clone();
  }

  if(mode === "scale"){
    const s = selectedObject.scale.x;
    selectedObject.scale.set(s,s,s);
    snapUniformScale(selectedObject, SNAP_STEP);
  }

  // For all modes, apply clamping to ensure objects stay within bounds
  // This includes rotation mode - objects should not be allowed to rotate outside the bounding box
  updateAllVisuals(selectedObject);

  // Update JSON editor to reflect local transform values for all objects
  updateJSONEditorFromScene();
});

// ===== Undo =====
const undoStack = [];
function saveState(){
  if (selectedObject) {
    undoStack.push({
      uuid: selectedObject.uuid,
      pos: selectedObject.position.clone(),
      rot: selectedObject.quaternion.clone(),
      scale: selectedObject.scale.clone()
    });
  }
}
function undo(){
  if (!selectedObject || !undoStack.length) return;

  // Find the most recent state for the currently selected object
  for (let i = undoStack.length - 1; i >= 0; i--){
    if (undoStack[i].uuid === selectedObject.uuid){
      const last = undoStack.splice(i, 1)[0];
      selectedObject.position.copy(last.pos);
      selectedObject.quaternion.copy(last.rot);
      selectedObject.scale.copy(last.scale);
      updateAllVisuals(selectedObject);
      break;
    }
  }
}

// ===== Render loop =====
function animate(){
  requestAnimationFrame(animate);
  orbit.update();
  renderer.render(scene, camera);
}
animate();

// ===== Context menu =====
const contextMenu = (function(){
  const menu = document.createElement('ul');
  menu.id = 'contextMenu';
  document.body.appendChild(menu);
  return menu;
})();

const contextActions = {
  "Duplicate": () => duplicateSelectedObjects(),
  "Dissolve Group": () => ungroupSelectedObject(),
  "Detach from Group": () => detachSelectedFromGroup(),
  "Reset Transform": () => selectedObjects.forEach(resetTransform),
  "Drop to Floor": () => selectedObjects.forEach(dropToFloor),
  "Select All": () => selectAllSidebar(),
  "Deselect All": () => deselectAllSidebar()
};

function showContextMenu(x,y,actions){
  contextMenu.innerHTML = "";
  actions.forEach(action=>{
    const li = document.createElement("li");
    li.textContent = action;
    li.style.padding = "4px 12px";
    li.style.cursor = "pointer";
    li.onmouseenter = () => li.style.background = "#444";
    li.onmouseleave = () => li.style.background = "transparent";
    li.onclick = () => { contextMenu.style.display="none"; contextActions[action]?.(); };
    contextMenu.appendChild(li);
  });
  contextMenu.style.left = x+"px";
  contextMenu.style.top = y+"px";
  contextMenu.style.display = "block";
}
document.addEventListener("click", ()=> contextMenu.style.display="none");

// Canvas context menu
renderer.domElement.addEventListener("contextmenu", e=>{
  e.preventDefault();
  let actions = ["Select All","Deselect All"];
  
  // Filter out canvas root from selected objects for context menu
  const nonCanvasObjects = selectedObjects.filter(obj => !obj.userData?.isCanvasRoot);
  
  // If only Object Root is selected, show limited options
  if (selectedObjects.length === 1 && selectedObjects[0].userData?.isCanvasRoot) {
    actions = ["Select All","Deselect All"];
  } else if (nonCanvasObjects.length > 0) {
    actions = ["Duplicate","Reset Transform","Drop to Floor","Select All","Deselect All"];

    if (nonCanvasObjects.length === 1) {
      const obj = nonCanvasObjects[0];
      // Check if it's a child in a group first (this handles both regular objects and nested groups)
      if (isChildObjectInGroup(obj)) {
        const parentGroup = obj.parent;
        if (parentGroup.children.length >= 3) {
          actions.splice(1, 0, "Detach from Group");
        } else {
          // Only 1 non-parent child left, show "Dissolve Group" to dissolve the parent group
          actions.splice(1, 0, "Dissolve Group");
        }
      }
      // If it's a parent group (but not a child in another group), show "Dissolve Group" to dissolve itself
      else if ((obj instanceof THREE.Group) && obj.userData?.isEditorGroup === true) {
        actions.splice(1, 0, "Dissolve Group"); // Insert "Dissolve Group" after "Duplicate"
      }
    } else {
      // Multiple objects selected - check if any are children in groups with enough children
      const hasDetachableChildren = nonCanvasObjects.some(obj => {
        if (!isChildObjectInGroup(obj)) return false;
        const parentGroup = obj.parent;
        return parentGroup.children.length >= 3;
      });
      if (hasDetachableChildren) {
        actions.splice(1, 0, "Detach from Group");
      }
    }
  }
  showContextMenu(e.clientX, e.clientY, actions);
});

// Sidebar context menu
modelList.addEventListener("contextmenu", e=>{
  e.preventDefault();
  const li = e.target.closest("li");
  if (!li) return;
  const obj = findObjectByListItem(li);
  if (!obj) return;
  if (!selectedObjects.includes(obj)) selectFromSidebar(obj, li, e);

  let actions = ["Select All","Deselect All"];
  
  // Filter out canvas root from selected objects for context menu
  const nonCanvasObjects = selectedObjects.filter(obj => !obj.userData?.isCanvasRoot);
  
  // If only Object Root is selected, show limited options
  if (selectedObjects.length === 1 && selectedObjects[0].userData?.isCanvasRoot) {
    actions = ["Select All","Deselect All"];
  } else if (nonCanvasObjects.length > 0) {
    actions = ["Duplicate","Reset Transform","Drop to Floor","Select All","Deselect All"];

    if (nonCanvasObjects.length === 1) {
      const obj = nonCanvasObjects[0];
      // Check if it's a child in a group first (this handles both regular objects and nested groups)
      if (isChildObjectInGroup(obj)) {
        const parentGroup = obj.parent;
        if (parentGroup.children.length >= 3) {
          actions.splice(1, 0, "Detach from Group");
        } else {
          // Only 1 non-parent child left, show "Dissolve Group" to dissolve the parent group
          actions.splice(1, 0, "Dissolve Group");
        }
      }
      // If it's a parent group (but not a child in another group), show "Dissolve Group" to dissolve itself
      else if ((obj instanceof THREE.Group) && obj.userData?.isEditorGroup === true) {
        actions.splice(1, 0, "Dissolve Group"); // Insert "Dissolve Group" after "Duplicate"
      }
    } else {
      // Multiple objects selected - check if any are children in groups with enough children
      const hasDetachableChildren = nonCanvasObjects.some(obj => {
        if (!isChildObjectInGroup(obj)) return false;
        const parentGroup = obj.parent;
        return parentGroup.children.length >= 3;
      });
      if (hasDetachableChildren) {
        actions.splice(1, 0, "Detach from Group");
      }
    }
  }
  showContextMenu(e.clientX, e.clientY, actions);
});

function findObjectByListItem(li){
  let found = null;
  scene.traverse(obj=>{
    if (obj.userData?.listItem === li) found = obj;
  });
  return found;
}

function selectAllSidebar(){
  deselectAllSidebar();
  
  // Get all selectable objects from canvas root
  const allObjects = [];
  canvasRoot.traverse(obj => {
    if (obj.userData?.isSelectable && obj !== canvasRoot) {
      allObjects.push(obj);
    }
  });
  
  allObjects.forEach(obj => {
    if (obj.userData.listItem) {
      obj.userData.listItem.classList.add("selected");
      selectedObjects.push(obj);
      setHelperVisible(obj, true);
      updateBoxHelper(obj, BOX_COLORS.selected);
      addBoundingBoxDimensions(obj);
    }
  });
  
  selectedObject = selectedObjects[selectedObjects.length-1] || null;
  if (selectedObject){
    updateModelProperties(selectedObject);
    updatePropertiesPanel(selectedObject);
  }
  updateTransformButtonStates();
}

function deselectAllSidebar(){
  selectedObjects.forEach(o=>{
    o.userData.listItem?.classList.remove("selected");
    setHelperVisible(o,false);
    // Hide parent box helper if object is a child in a group
    if (isChildObjectInGroup(o) && o.parent) {
      setParentHelperVisible(o.parent, false);
    }
    // Hide child bounding boxes if object is a group
    if (o.userData?.isEditorGroup) {
      showChildBoundingBoxes(o, false);
    }
    // Hide Object Root children bounding boxes
    if (o.userData?.isCanvasRoot) {
      showObjectRootChildrenBoundingBoxes(o, false);
    }
    if (o.userData.dimGroup) scene.remove(o.userData.dimGroup);
  });
  selectedObjects = [];
  selectedObject = null;
  transform.detach();
  updatePropertiesPanel(null);
  updateTransformButtonStates();
}


// ===== Export JSON (quaternions) =====
function buildNode(obj){
  if (!obj.userData?.isSelectable) return null;
  const box = getBox(obj); // Use the updated getBox function that handles Object Root properly
  const size = box.getSize(new THREE.Vector3());

  // Use local transforms for all objects to show relative positioning
  const localPosition = obj.position.clone();
  const localQuaternion = obj.quaternion.clone();
  const localScale = obj.scale.clone();

  const rawName = (obj.name && obj.name.length) ? obj.name :
    (obj.userData.listItem ? obj.userData.listItem.textContent : "FILE");
  const baseName = rawName.replace(/\.[^/.]+$/, "");
  const sourceRef = obj.userData?.sourceRef;

  const node = {
    pResource: {
      sName: obj.name || baseName,
      sReference: (obj instanceof THREE.Group && obj.userData?.isEditorGroup === true)
        ? (obj.children[0]?.userData?.sourceRef?.reference || (baseName + ".glb"))
        : (sourceRef?.reference || (baseName + ".glb"))
    },
    pTransform: {
      aPosition: [localPosition.x, localPosition.y, localPosition.z],
      aRotation: [localQuaternion.x, localQuaternion.y, localQuaternion.z, localQuaternion.w],
      aScale: [localScale.x, localScale.y, localScale.z]
    },
    aBound: [size.x, size.y, size.z],
    aChildren: []
  };

  // Special handling for Object Root - no sReference required
  if (obj.userData?.isCanvasRoot) {
    node.pResource = {
      sName: baseName,
      // No sReference for Object Root
    };
  }

  if (obj instanceof THREE.Group) {
    // For Object Root, export all children normally
    if (obj.userData?.isCanvasRoot) {
      obj.children.forEach(child=>{
        const childNode = buildNode(child);
        if (childNode) node.aChildren.push(childNode);
      });
    } else {
      // For editor groups, skip the first child (parent object) and only export other children
      const childrenToExport = obj.userData?.isEditorGroup === true
        ? obj.children.slice(1)
        : obj.children;

      childrenToExport.forEach(child=>{
        const childNode = buildNode(child);
        if (childNode) node.aChildren.push(childNode);
      });
    }
  }

  return node;
}

function generateSceneJSON() {
  const objectRootNode = buildNode(canvasRoot);
  const exportData = objectRootNode ? [objectRootNode] : [];
  return JSON.stringify(exportData, null, 2);
}

function updateJSONEditor() {
  if (jsonEditor) {
    jsonEditor.value = generateSceneJSON();
  }
}

// Export JSON button
exportJson.onclick = ()=>{
  const jsonText = generateSceneJSON();
  const blob = new Blob([jsonText], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "scene.json"; a.click();
  URL.revokeObjectURL(url);
};

// ===== JSON Editor Sync =====
let originalJSON = '';
let hasUnsavedChanges = false;

// Update JSON editor when scene changes
function updateJSONEditorFromScene() {
  if (jsonEditor && !hasUnsavedChanges) {
    originalJSON = generateSceneJSON();
    jsonEditor.value = originalJSON;
  }
}

// Parse JSON and update scene
async function parseJSONAndUpdateScene(jsonText) {
  try {
    const data = JSON.parse(jsonText);
    
    if (!Array.isArray(data) || data.length === 0) {
      return;
    }

    const rootNode = data[0];
    
    if (!rootNode || !rootNode.pResource) {
      return;
    }

    // Handle Object Root aBound changes - update canvas size if aBound is provided
    if (rootNode.aBound && Array.isArray(rootNode.aBound) && rootNode.aBound.length >= 3) {
      const newCanvasSize = rootNode.aBound[0]; // Use X dimension as canvas size
      if (newCanvasSize !== groundSize) {
        groundSize = newCanvasSize;
        
        // Update UI input field
        canvasSizeInput.value = groundSize;
        
        // Update grid
        scene.remove(grid);
        grid = new THREE.GridHelper(groundSize, groundSize, 0x888888, 0x444444);
        grid.userData.isSelectable = false;
        scene.add(grid);
        
        // Update ruler
        if (ruler) scene.remove(ruler);
        if (loadedFont) {
          ruler = createRuler(groundSize, 1);
          addRulerLabels(ruler, groundSize, 1, loadedFont);
          ruler.userData.isSelectable = false;
          scene.add(ruler);
        }
        
        // Update camera orbit controls
        orbit.maxDistance = groundSize * 1.5;
        
        // Update selected objects visuals (without JSON editor update to avoid premature updates)
        selectedObjects.forEach(o => {
          if(!o) return;
          
          // Skip canvas clamping for objects imported from JSON
          if (!o.userData?.isImportedFromJSON) {
            clampToCanvasRecursive(o);
          }
          
          updateModelProperties(o);
          updatePropertiesPanel(o);
          updateBoxHelper(o);
          
          // If this is a group, also update child bounding boxes
          if (o.userData?.isEditorGroup) {
            updateChildBoundingBoxes(o);
          }
          
          // If this object is a child in a group, update the parent group's bounding box
          if (isChildObjectInGroup(o) && o.parent) {
            updateParentGroupBounds(o.parent);
          }
          
          // Only add dimension labels for selected objects
          if(selectedObjects.includes(o)) {
            addBoundingBoxDimensions(o);
          }
          
          // Note: NOT calling updateJSONEditorFromScene() here to avoid premature JSON updates
        });
        
        // Update canvas root box helper if it exists
        if (canvasRoot.userData.boxHelper) {
          updateCanvasBoxHelper(canvasRoot);
        }
        
        // Update Object Root aBound and properties to reflect new canvas size
        canvasRoot.userData.aBound = [groundSize, groundSize, groundSize];
        updateModelProperties(canvasRoot);
        if (selectedObjects.includes(canvasRoot)) {
          updatePropertiesPanel(canvasRoot);
        }
      }
    }

    // Create a map of existing objects by composite key (name + sReference + uniqueId) for reference
    const existingObjects = new Map();
    canvasRoot.traverse(obj => {
      if (obj.userData?.isSelectable && obj !== canvasRoot && obj.name) {
        const sReference = obj.userData?.sourceRef?.reference || '';
        const uniqueId = obj.userData?.uniqueInternalId || '';
        const compositeKey = uniqueId ? 
          `${obj.name}|${sReference}|${uniqueId}` :
          `${obj.name}|${sReference}`;
        existingObjects.set(compositeKey, obj);
      }
    });
    

    // Process objects and create groups based on JSON hierarchy
    if (rootNode.aChildren && Array.isArray(rootNode.aChildren)) {
      for (const childNode of rootNode.aChildren) {
        await processNodeHierarchically(childNode, canvasRoot, existingObjects);
      }
    }

    // Remove objects that are no longer in the JSON
    const jsonObjectKeys = new Set();
    if (rootNode.aChildren) {
      rootNode.aChildren.forEach(childNode => {
        collectObjectKeysRecursively(childNode, jsonObjectKeys);
      });
    }
    
    existingObjects.forEach((obj, key) => {
      // Check if this object should be kept by looking at the base composite key
      // (without unique identifier) to see if it exists in the JSON
      const baseKey = key.split('|').slice(0, 2).join('|'); // Remove unique identifier suffix
      if (!jsonObjectKeys.has(baseKey)) {
        cleanupObject(obj);
        if (obj.parent) obj.parent.remove(obj);
      }
    });

    // Update original JSON and hide apply button
      originalJSON = jsonText;
      hasUnsavedChanges = false;
      applyChanges.style.display = 'none';
      
      // Clear the isImportedFromJSON flags and jsonBounds so normal 3D editing rules apply
      scene.traverse((obj) => {
        if (obj.userData?.isImportedFromJSON) {
          delete obj.userData.isImportedFromJSON;
        }
        if (obj.userData?.jsonBounds) {
          delete obj.userData.jsonBounds;
        }
      });
      
      // Update JSON editor to reflect any changes (including canvas size changes)
      updateJSONEditor();
      
    } catch (error) {
      console.error('❌ Error parsing JSON:', error);
      alert('Invalid JSON format. Please check your syntax.');
      // Restore original JSON on error
      jsonEditor.value = originalJSON;
    }
}

async function processNodeHierarchically(node, parent, existingObjects) {
  if (!node || !node.pResource) return null;
  
  // Create the object first
  const obj = await updateOrCreateObject(node, parent, existingObjects);
  if (!obj) return null;
  
  // Check if this object has children
  if (node.aChildren && Array.isArray(node.aChildren) && node.aChildren.length > 0) {
    
    // Check if the object is already a group - if so, we can reuse it
    let group;
    if (obj instanceof THREE.Group && obj.userData?.isEditorGroup) {
      group = obj;
      
      // Update the group's transform from JSON
      if (node.pTransform) {
        if (node.pTransform.aPosition) {
          group.position.set(
            node.pTransform.aPosition[0],
            node.pTransform.aPosition[1],
            node.pTransform.aPosition[2]
          );
        }
        if (node.pTransform.aRotation) {
          group.quaternion.set(
            node.pTransform.aRotation[0],
            node.pTransform.aRotation[1],
            node.pTransform.aRotation[2],
            node.pTransform.aRotation[3]
          );
        }
        if (node.pTransform.aScale) {
          group.scale.set(
            node.pTransform.aScale[0],
            node.pTransform.aScale[1],
            node.pTransform.aScale[2]
          );
        }
      }
      
      // Store bounding box from JSON if available
      if (node.aBound && Array.isArray(node.aBound) && node.aBound.length >= 3) {
        group.userData.jsonBounds = {
          size: new THREE.Vector3(node.aBound[0], node.aBound[1], node.aBound[2])
        };
      }
      
      // Mark as imported from JSON
      group.userData.isImportedFromJSON = true;
      
    } else {
      // This object has children, so we need to create an editor group
      group = new THREE.Group();
      group.userData.isSelectable = true;
      group.userData.isEditorGroup = true;
      group.userData.isImportedFromJSON = true; // Mark as imported from JSON to skip canvas clamping
      group.name = obj.name || "Attached " + Date.now();
      
      
      // Use local transform values directly from JSON
      if (node.pTransform) {
        if (node.pTransform.aPosition) {
          group.position.set(
            node.pTransform.aPosition[0],
            node.pTransform.aPosition[1],
            node.pTransform.aPosition[2]
          );
        }
        if (node.pTransform.aRotation) {
          group.quaternion.set(
            node.pTransform.aRotation[0],
            node.pTransform.aRotation[1],
            node.pTransform.aRotation[2],
            node.pTransform.aRotation[3]
          );
        }
        if (node.pTransform.aScale) {
          group.scale.set(
            node.pTransform.aScale[0],
            node.pTransform.aScale[1],
            node.pTransform.aScale[2]
          );
        }
      }
      
      // Store bounding box from JSON if available
      if (node.aBound && Array.isArray(node.aBound) && node.aBound.length >= 3) {
        group.userData.jsonBounds = {
          size: new THREE.Vector3(node.aBound[0], node.aBound[1], node.aBound[2])
        };
      } else {
      }
      
      
      // Remove object from its current parent and add it as first child of group
      parent.remove(obj);
      group.add(obj);
      
      // Reset object's transform relative to group (it becomes the "parent" object)
      obj.position.set(0, 0, 0);
      obj.quaternion.set(0, 0, 0, 1);
      obj.scale.set(1, 1, 1);
      
      // Clean up object's sidebar representation
      if (obj.userData.listItem) {
        const li = obj.userData.listItem;
        const next = li.nextSibling;
        li.remove();
        if(next && next.tagName==="UL") next.remove();
        delete obj.userData.listItem;
      }
      
      // Add group to parent
      parent.add(group);
      
      
      // Force matrix update to ensure transforms are applied
      scene.updateMatrixWorld(true);
    }
    
    // Process children and add them to the group using EXACT JSON values
    for (const childNode of node.aChildren) {
      const childObject = await processNodeHierarchically(childNode, group, existingObjects);
      if (childObject) {
        // Store original metadata for the child
        if (!childObject.userData) childObject.userData = {};
        childObject.userData.originalListType = childObject.userData.listType || (childObject instanceof THREE.Group ? "group" : "model");
        childObject.userData.originalName = childObject.name;
        
        // Store expected local position from JSON for comparison
        if (childNode.pTransform?.aPosition) {
          childObject.userData.expectedLocalPosition = childNode.pTransform.aPosition;
        }
        
        // Clean up existing helpers and sidebar representation
        if(childObject.userData.boxHelper){ scene.remove(childObject.userData.boxHelper); delete childObject.userData.boxHelper; }
        if(childObject.userData.dimGroup){ scene.remove(childObject.userData.dimGroup); delete childObject.userData.dimGroup; }
        if (childObject.userData.listItem) {
          const li = childObject.userData.listItem;
          const next = li.nextSibling;
          li.remove();
          if(next && next.tagName==="UL") next.remove();
          delete childObject.userData.listItem;
        }
        
        
        // Use local transform values directly from JSON
        if (childNode.pTransform) {
          if (childNode.pTransform.aPosition) {
            childObject.position.set(
              childNode.pTransform.aPosition[0],
              childNode.pTransform.aPosition[1],
              childNode.pTransform.aPosition[2]
            );
          }
          if (childNode.pTransform.aRotation) {
            childObject.quaternion.set(
              childNode.pTransform.aRotation[0],
              childNode.pTransform.aRotation[1],
              childNode.pTransform.aRotation[2],
              childNode.pTransform.aRotation[3]
            );
          }
          if (childNode.pTransform.aScale) {
            childObject.scale.set(
              childNode.pTransform.aScale[0],
              childNode.pTransform.aScale[1],
              childNode.pTransform.aScale[2]
            );
          }
        }
        
        // Store bounding box from JSON if available
        if (childNode.aBound && Array.isArray(childNode.aBound) && childNode.aBound.length >= 3) {
          childObject.userData.jsonBounds = {
            size: new THREE.Vector3(childNode.aBound[0], childNode.aBound[1], childNode.aBound[2])
          };
        } else {
        }
        
        
        // Remove from current parent and add to group
        if (childObject.parent) {
          childObject.parent.remove(childObject);
        }
        group.add(childObject);
        
      }
    }
    
    // Create helpers and add to sidebar
    createBoxHelperFor(group);
    createParentBoxHelperFor(group);
    addGroupToList(group, group.name);
    
    // Update visuals
    updateAllVisuals(group);
    storeInitialTransform(group);
    
    
    return group;
  } else {
    // No children, just return the object
    return obj;
  }
}

function collectObjectKeysRecursively(node, keys) {
  if (node && node.pResource && node.pResource.sName) {
    const sReference = node.pResource.sReference || '';
    // Use base composite key (without unique identifier) for JSON key collection
    // This allows the cleanup logic to work with the original sName|sReference format
    const baseCompositeKey = `${node.pResource.sName}|${sReference}`;
    keys.add(baseCompositeKey);
  }
  if (node.aChildren && Array.isArray(node.aChildren)) {
    node.aChildren.forEach(childNode => {
      collectObjectKeysRecursively(childNode, keys);
    });
  }
}

function collectObjectKeys(node, keys) {
  if (node && node.pResource && node.pResource.sName) {
    const sReference = node.pResource.sReference || '';
    const compositeKey = `${node.pResource.sName}|${sReference}`;
    keys.add(compositeKey);
  }
  if (node.aChildren && Array.isArray(node.aChildren)) {
    node.aChildren.forEach(childNode => {
      collectObjectKeys(childNode, keys);
    });
  }
}

async function updateOrCreateObject(node, parent, existingObjects) {
  if (!node || !node.pResource) return null;

  const objectName = node.pResource.sName || "Imported Object";
  const sReference = node.pResource.sReference || '';
  
  // First, try to find an existing object by base key (without unique ID)
  const baseKey = `${objectName}|${sReference}`;
  let obj = null;
  let uniqueId = '';
  
  // Look for existing object with matching base key
  for (const [key, existingObj] of existingObjects) {
    if (key.startsWith(baseKey + '|') || key === baseKey) {
      obj = existingObj;
      uniqueId = existingObj.userData?.uniqueInternalId || '';
      break;
    }
  }
  
  // If no existing object found, generate a new unique ID
  if (!obj) {
    uniqueId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  // Create a composite key using sName, sReference, and the unique internal identifier
  const compositeKey = `${objectName}|${sReference}|${uniqueId}`;
  
  if (obj) {
    // Update existing object
    updateObjectFromNode(obj, node, existingObjects);
    
    // If this object has children, we need to ensure it's properly structured as a group
    // The existing object might not be a group, so we need to handle this case
    if (node.aChildren && Array.isArray(node.aChildren) && node.aChildren.length > 0) {
      // The processNodeHierarchically function will handle creating the group structure
      // We just need to make sure the existing object is marked correctly
    }
    
    return obj;
  } else {
    // Check if we have an object with the same sReference (for model reuse)
    // but different sName (for unique identification)
    let modelToReuse = null;
    if (sReference) {
      for (const [key, existingObj] of existingObjects) {
        if (existingObj.userData?.sourceRef?.reference === sReference) {
          modelToReuse = existingObj;
          break;
        }
      }
    }
    
    if (modelToReuse) {
      // Reuse the existing model but create a new object instance
      obj = modelToReuse.clone(true);
      // Use the original object name (no visible suffixes)
      obj.name = objectName;
      
      // Deep clone materials and geometries to avoid sharing
      obj.traverse(node => {
        if (node.isMesh) {
          if (node.material) {
            if (Array.isArray(node.material)) {
              node.material = node.material.map(mat => mat.clone());
            } else {
              node.material = node.material.clone();
            }
          }
          if (node.geometry) {
            node.geometry = node.geometry.clone();
          }
        }
      });
      
      // Set up proper userData for editor functionality
      obj.userData = {
        isSelectable: true,
        isImportedFromJSON: true, // Mark as imported from JSON to skip canvas clamping
        uniqueInternalId: uniqueId, // Store the unique internal identifier
        sourceRef: {
          reference: sReference,
          originalFileName: sReference,
          baseName: objectName
        }
      };
      
      // Store bounding box from JSON if available
      if (node.aBound && Array.isArray(node.aBound) && node.aBound.length >= 3) {
        obj.userData.jsonBounds = {
          size: new THREE.Vector3(node.aBound[0], node.aBound[1], node.aBound[2])
        };
      }
      
      // Apply the transform from the JSON
      if (node.pTransform) {
        if (node.pTransform.aPosition) {
          obj.position.set(
            node.pTransform.aPosition[0],
            node.pTransform.aPosition[1],
            node.pTransform.aPosition[2]
          );
        }
        if (node.pTransform.aRotation) {
          obj.quaternion.set(
            node.pTransform.aRotation[0],
            node.pTransform.aRotation[1],
            node.pTransform.aRotation[2],
            node.pTransform.aRotation[3]
          );
        }
        if (node.pTransform.aScale) {
          obj.scale.set(
            node.pTransform.aScale[0],
            node.pTransform.aScale[1],
            node.pTransform.aScale[2]
          );
        }
      } else {
      }
      
      parent.add(obj);
      createBoxHelperFor(obj);
      addModelToList(obj, obj.name);
      storeInitialTransform(obj);
      
      // Add the new object to the existingObjects map
      existingObjects.set(compositeKey, obj);
    } else {
      // Create completely new object
      obj = await createObjectFromNode(node);
      if (obj) {
        // Use the original object name (no visible suffixes)
        obj.name = objectName;
        
        // Add the unique internal identifier to userData
        if (!obj.userData) obj.userData = {};
        obj.userData.uniqueInternalId = uniqueId;
        
        parent.add(obj);
        createBoxHelperFor(obj);
        addModelToList(obj, obj.name);
        storeInitialTransform(obj);
        
        // Add the new object to the existingObjects map
        existingObjects.set(compositeKey, obj);
      }
    }
  }


  return obj;
}

function updateObjectFromNode(obj, node, existingObjects) {
  
  // Store the old composite key before making changes
  // Include the unique identifier if it exists
  const uniqueId = obj.userData?.uniqueInternalId || '';
  const oldCompositeKey = uniqueId ? 
    `${obj.name}|${obj.userData.sourceRef?.reference || ''}|${uniqueId}` :
    `${obj.name}|${obj.userData.sourceRef?.reference || ''}`;
  
  // Mark as imported from JSON to skip canvas clamping
  obj.userData.isImportedFromJSON = true;
  
  // Update name if it changed
  if (node.pResource && node.pResource.sName && obj.name !== node.pResource.sName) {
    obj.name = node.pResource.sName;
    // Update sidebar label
    if (obj.userData.listItem) {
      const label = obj.userData.listItem.querySelector('span');
      if (label) {
        label.textContent = obj.name;
      }
    }
  }

  // Update sourceRef from JSON to ensure round-trip consistency
  // This allows objects with shared sReference values to be properly maintained
  if (node.pResource && node.pResource.sReference !== undefined) {
    obj.userData.sourceRef = {
      reference: node.pResource.sReference || '',
      originalFileName: node.pResource.sReference || '',
      baseName: node.pResource.sName || obj.name || "Imported Object"
    };
  }

  // Store bounding box from JSON if available
  if (node.aBound && Array.isArray(node.aBound) && node.aBound.length >= 3) {
    obj.userData.jsonBounds = {
      size: new THREE.Vector3(node.aBound[0], node.aBound[1], node.aBound[2])
    };
  }

  // Update the existingObjects map if the composite key changed
  if (existingObjects) {
    const newCompositeKey = uniqueId ? 
      `${obj.name}|${obj.userData.sourceRef?.reference || ''}|${uniqueId}` :
      `${obj.name}|${obj.userData.sourceRef?.reference || ''}`;
    if (oldCompositeKey !== newCompositeKey) {
      existingObjects.delete(oldCompositeKey);
      existingObjects.set(newCompositeKey, obj);
    }
  }

  // Update transform
  if (node.pTransform) {
    if (node.pTransform.aPosition) {
      obj.position.set(
        node.pTransform.aPosition[0],
        node.pTransform.aPosition[1],
        node.pTransform.aPosition[2]
      );
    }
    if (node.pTransform.aRotation) {
      obj.quaternion.set(
        node.pTransform.aRotation[0],
        node.pTransform.aRotation[1],
        node.pTransform.aRotation[2],
        node.pTransform.aRotation[3]
      );
    }
    if (node.pTransform.aScale) {
      obj.scale.set(
        node.pTransform.aScale[0],
        node.pTransform.aScale[1],
        node.pTransform.aScale[2]
      );
    }
  }

  // Update properties and visuals
  updateAllVisuals(obj);
}

async function createObjectFromNode(node) {
  const sReference = node.pResource.sReference || '';
  const objectName = node.pResource.sName || "Imported Object";
  
  try {
    // Load the model from sReference (URL or local file)
    const sourceModel = await loadModelFromReference(sReference, node.aBound);
    
    // Clone the model to create a new instance
    const obj = sourceModel.clone(true);
    
    // Deep clone materials and geometries to avoid sharing
    obj.traverse(node => {
      if (node.isMesh) {
        if (node.material) {
          if (Array.isArray(node.material)) {
            node.material = node.material.map(mat => mat.clone());
          } else {
            node.material = node.material.clone();
          }
        }
        if (node.geometry) {
          node.geometry = node.geometry.clone();
        }
      }
    });
    
    obj.userData.isSelectable = true;
    obj.userData.isImportedFromJSON = true; // Mark as imported from JSON to skip canvas clamping
    obj.name = objectName;

    // Always set source reference from JSON, even if empty
    // This ensures consistent behavior for objects with shared sReference values
    obj.userData.sourceRef = {
      reference: sReference,
      originalFileName: sReference,
      baseName: objectName
    };

    // Store bounding box from JSON if available
    if (node.aBound && Array.isArray(node.aBound) && node.aBound.length >= 3) {
      obj.userData.jsonBounds = {
        size: new THREE.Vector3(node.aBound[0], node.aBound[1], node.aBound[2])
      };
    }

    // Apply transform
    if (node.pTransform) {
      if (node.pTransform.aPosition) {
        obj.position.set(
          node.pTransform.aPosition[0],
          node.pTransform.aPosition[1],
          node.pTransform.aPosition[2]
        );
      }
      if (node.pTransform.aRotation) {
        obj.quaternion.set(
          node.pTransform.aRotation[0],
          node.pTransform.aRotation[1],
          node.pTransform.aRotation[2],
          node.pTransform.aRotation[3]
        );
      }
      if (node.pTransform.aScale) {
        obj.scale.set(
          node.pTransform.aScale[0],
          node.pTransform.aScale[1],
          node.pTransform.aScale[2]
        );
      }
    }

    return obj;
  } catch (error) {
    console.error(`Failed to create object from node with sReference: ${sReference}`, error);
    
    // Create a fallback placeholder object
    // Use bounding box dimensions if available, otherwise default to 1x1x1
    const dimensions = node.aBound && Array.isArray(node.aBound) && node.aBound.length >= 3 
      ? node.aBound 
      : [1, 1, 1];
    
    const geometry = new THREE.BoxGeometry(dimensions[0], dimensions[1], dimensions[2]);
    // Translate geometry so local origin is at bottom center instead of center
    geometry.translate(0, dimensions[1] / 2, 0);
    const material = new THREE.MeshBasicMaterial({ color: 0xff0000 }); // Red to indicate error
    const obj = new THREE.Mesh(geometry, material);
    
    obj.userData.isSelectable = true;
    obj.userData.isImportedFromJSON = true;
    obj.name = `${objectName} (Failed to Load)`;
    obj.userData.sourceRef = {
      reference: sReference,
      originalFileName: sReference,
      baseName: objectName
    };
    
    return obj;
  }
}

// JSON editor event listeners
if (jsonEditor) {
  // Detect changes in JSON editor
  jsonEditor.addEventListener('input', () => {
    hasUnsavedChanges = jsonEditor.value !== originalJSON;
    applyChanges.style.display = hasUnsavedChanges ? 'block' : 'none';
  });

  // Focus event - deselect all objects when JSON editor is focused
  jsonEditor.addEventListener('focus', () => {
    deselectAllSidebar();
  });

  // Apply changes button
  applyChanges.addEventListener('click', async () => {
    await parseJSONAndUpdateScene(jsonEditor.value);
  });

  // Initial JSON update
  updateJSONEditorFromScene();
}
